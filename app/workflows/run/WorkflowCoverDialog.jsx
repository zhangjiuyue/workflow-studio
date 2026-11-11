"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  buildToolImageDownloadUrl,
  generateImages,
  listAssets,
  resolveFlowStudioFileUrl,
  updateWorkflowRun,
} from "../../../lib/flowstudio-api";
import { imageModelsForApiKey } from "../../../lib/image-model-options";
import {
  WORKFLOW_COVER_MAX_ROLE_IMAGES,
  buildWorkflowCoverPrompt,
  collectWorkflowCoverRoleImages,
  composeWorkflowCoverInstruction,
  normalizeWorkflowCoverCount,
  validateWorkflowCoverRoleCount,
  workflowCoverContentReferenceLabel,
  workflowCoverCountOptions,
  workflowCoverTypeLabel,
} from "../../../lib/workflow-cover.mjs";

export default function WorkflowCoverDialog({ run, workflow, imageKeys = [], onClose, onRunUpdated }) {
  const workflowType = workflow?.type || workflow?.workflowType || "explain";
  const [mounted, setMounted] = useState(false);
  const [promptAssets, setPromptAssets] = useState([]);
  const [imageKeyId, setImageKeyId] = useState(() => preferredImageKey(imageKeys, workflow)?.id || "");
  const initialImageKey = preferredImageKey(imageKeys, workflow);
  const initialImageModels = coverImageModels(initialImageKey);
  const initialImageModel = preferredImageModel(initialImageModels, workflow);
  const [imageModelId, setImageModelId] = useState(initialImageModel?.id || "");
  const [imageResolution, setImageResolution] = useState(() => optionValue(initialImageModel?.resolutions, workflow?.imageResolution));
  const [ratio, setRatio] = useState(() => preferredRatio(initialImageModel, workflow?.ratio));
  const [customSize, setCustomSize] = useState(workflow?.imageSize || "");
  const [count, setCount] = useState(1);
  const [selectedRoleImageIds, setSelectedRoleImageIds] = useState([]);
  const [includeContentReference, setIncludeContentReference] = useState(true);
  const [includeSystemPrompt, setIncludeSystemPrompt] = useState(true);
  const [promptAssetId, setPromptAssetId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [previewImage, setPreviewImage] = useState(null);
  const [message, setMessage] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generationProgress, setGenerationProgress] = useState({ done: 0, total: 0 });

  const runView = useMemo(() => normalizeCoverRun(run), [run]);
  const imageKey = imageKeys.find((item) => item.id === imageKeyId) || imageKeys[0] || null;
  const imageModels = coverImageModels(imageKey);
  const imageModel = imageModels.find((item) => item.id === imageModelId) || imageModels[0] || null;
  const ratioOptions = coverRatioOptions(imageModel);
  const roleImages = useMemo(() => collectWorkflowCoverRoleImages(runView).map((image) => ({
    ...image,
    url: resolveFlowStudioFileUrl(image.url),
    thumbnailUrl: resolveFlowStudioFileUrl(image.thumbnailUrl || ""),
  })), [runView]);
  const selectedRoleImageSet = new Set(selectedRoleImageIds);
  const selectedRoleImages = roleImages.filter((image) => selectedRoleImageSet.has(image.id));
  const coverImages = coverImagesFromRun(runView);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    let active = true;
    listAssets("prompt").then((result) => {
      if (!active) return;
      setPromptAssets(normalizePromptAssets(result));
    }).catch(() => {
      if (active) setPromptAssets([]);
    });
    return () => {
      active = false;
    };
  }, []);

  function updateImageKey(nextKeyId) {
    const nextKey = imageKeys.find((item) => item.id === nextKeyId) || null;
    const nextModels = coverImageModels(nextKey);
    const nextModel = nextModels[0] || null;
    setImageKeyId(nextKeyId);
    setImageModelId(nextModel?.id || "");
    setImageResolution(optionValue(nextModel?.resolutions, ""));
    setRatio(coverRatioOptions(nextModel)[0]?.value || "");
    setCustomSize("");
  }

  function updateImageModel(nextModelId) {
    const nextModel = imageModels.find((item) => item.id === nextModelId) || imageModels[0] || null;
    const nextRatios = coverRatioOptions(nextModel);
    const nextRatio = nextRatios.some((item) => item.value === ratio) ? ratio : nextRatios[0]?.value || "";
    setImageModelId(nextModel?.id || "");
    setImageResolution(optionValue(nextModel?.resolutions, imageResolution));
    setRatio(nextRatio);
    if (nextRatio !== "custom") setCustomSize("");
  }

  function toggleRoleImage(imageId) {
    setSelectedRoleImageIds((current) => {
      if (current.includes(imageId)) {
        const next = current.filter((id) => id !== imageId);
        if (!validateWorkflowCoverRoleCount(next.length)) setMessage("");
        return next;
      }
      const next = [...current, imageId];
      const validation = validateWorkflowCoverRoleCount(next.length);
      if (validation) {
        setMessage(validation);
        return next;
      }
      setMessage("");
      return next;
    });
  }

  function selectAllRoleImages() {
    const validation = validateWorkflowCoverRoleCount(roleImages.length);
    setSelectedRoleImageIds(roleImages.map((image) => image.id));
    if (validation) {
      setMessage(`当前共有 ${roleImages.length} 张可选角色图，${validation}`);
      return;
    }
    setMessage(roleImages.length ? `已选择全部 ${roleImages.length} 张角色图。` : "当前任务没有可用角色图。");
  }

  function importPrompt() {
    const asset = promptAssets.find((item) => item.id === promptAssetId);
    if (!asset) return;
    setPrompt(asset.prompt);
    setMessage(`已导入“${asset.name}”，可继续编辑。`);
  }

  async function persistCoverResult(resultPatch) {
    const updated = await updateWorkflowRun(run.id, { resultPatch });
    if (updated?.run) onRunUpdated?.(updated.run);
    return updated?.run || null;
  }

  async function handleGenerate() {
    if (generating) return;
    const effectivePrompt = composeWorkflowCoverInstruction({
      type: workflowType,
      includeSystemPrompt,
      userPrompt: prompt,
    });
    const validation = validateGeneration({
      imageKey,
      imageModel,
      ratio,
      customSize,
      prompt: effectivePrompt,
      selectedRoleImages,
      includeContentReference,
      workflowType,
      run: runView,
    });
    if (validation) {
      setMessage(validation);
      return;
    }

    const requestedCount = normalizeWorkflowCoverCount(count);
    const finalPrompt = buildWorkflowCoverPrompt({
      type: workflowType,
      prompt: effectivePrompt,
      includeContentReference,
      topic: runView.topic,
      script: coverScript(runView),
      roleReferenceCount: selectedRoleImages.length,
    });
    const references = selectedRoleImages.map((image) => ({ id: image.id, name: image.name, url: image.url, fileUrl: image.url }));
    const startedAt = new Date().toISOString();
    let nextImages = [...coverImages];
    let completed = 0;
    let failed = 0;
    let lastError = "";
    setGenerating(true);
    setGenerationProgress({ done: 0, total: requestedCount });
    setMessage(`正在生成 0/${requestedCount} 张封面...`);

    try {
      await persistCoverResult({
        coverGeneration: { status: "running", done: 0, total: requestedCount, error: "", startedAt, updatedAt: startedAt },
      });

      for (let index = 0; index < requestedCount; index += 1) {
        try {
          const result = await generateImages({
            apiKeyId: imageKey.id,
            channel: imageKey.channel || "",
            modelId: imageModel.modelId || imageModel.id,
            prompt: finalPrompt,
            references,
            ratio,
            imageSize: pixelImageSize(ratio),
            customSize: ratio === "custom" ? customSize.trim() : "",
            resolution: imageResolution,
            format: "png",
            count: 1,
            taskType: "workflow-cover",
          });
          const generated = firstGeneratedImage(result);
          if (!generated.url) throw new Error("图片渠道已返回，但没有解析到封面图片。");
          nextImages = [{
            id: globalThis.crypto?.randomUUID?.() || `cover-${Date.now()}-${index + 1}`,
            url: resolveFlowStudioFileUrl(generated.url),
            thumbnailUrl: resolveFlowStudioFileUrl(generated.thumbnailUrl || ""),
            thumbnailMimeType: generated.thumbnailMimeType || "",
            prompt: finalPrompt,
            userPrompt: prompt.trim(),
            includeSystemPrompt,
            workflowType,
            imageKeyId: imageKey.id,
            imageChannel: imageKey.channel || "",
            imageModelId: imageModel.modelId || imageModel.id,
            imageModelName: imageModel.name || imageModel.id,
            ratio,
            customSize: ratio === "custom" ? customSize.trim() : "",
            resolution: imageResolution,
            includeContentReference,
            roleReferenceImageIds: selectedRoleImages.map((image) => image.id),
            roleReferenceImageNames: selectedRoleImages.map((image) => image.name),
            createdAt: new Date().toISOString(),
          }, ...nextImages];
          completed += 1;
        } catch (error) {
          failed += 1;
          lastError = error.message || `第 ${index + 1} 张封面生成失败。`;
        }

        const done = index + 1;
        const status = done === requestedCount ? (completed ? (failed ? "partial" : "done") : "error") : "running";
        setGenerationProgress({ done, total: requestedCount });
        setMessage(`封面生成进度 ${done}/${requestedCount}${failed ? `，失败 ${failed} 张` : ""}。`);
        await persistCoverResult({
          coverImages: nextImages,
          coverGeneration: {
            status,
            done,
            total: requestedCount,
            completed,
            failed,
            error: lastError,
            startedAt,
            updatedAt: new Date().toISOString(),
            completedAt: done === requestedCount ? new Date().toISOString() : "",
          },
        });
      }

      setMessage(completed
        ? `已生成 ${completed} 张封面${failed ? `，另有 ${failed} 张失败` : ""}。`
        : lastError || "封面生成失败。");
    } catch (error) {
      const errorMessage = error.message || "封面生成失败。";
      setMessage(errorMessage);
      await persistCoverResult({
        coverImages: nextImages,
        coverGeneration: {
          status: "error",
          done: completed + failed,
          total: requestedCount,
          completed,
          failed: Math.max(failed, 1),
          error: errorMessage,
          startedAt,
          updatedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        },
      }).catch(() => null);
    } finally {
      setGenerating(false);
    }
  }

  async function deleteCover(imageId) {
    if (generating) return;
    try {
      await persistCoverResult({ coverImages: coverImages.filter((image) => image.id !== imageId) });
      setMessage("封面已删除。");
    } catch (error) {
      setMessage(error.message || "封面删除失败。");
    }
  }

  if (!mounted || typeof document === "undefined") return null;

  return createPortal(
    <>
      <div className="workflow-image-dialog-backdrop-next" role="presentation" onClick={generating ? undefined : onClose}>
        <section className="workflow-image-retry-dialog-next workflow-cover-dialog-next" role="dialog" aria-modal="true" aria-label="生成封面" onClick={(event) => event.stopPropagation()}>
        <button className="workflow-dialog-close-next" type="button" disabled={generating} onClick={onClose} aria-label="关闭">×</button>
        <div className="workflow-cover-dialog-head-next">
          <div>
            <h3>生成封面</h3>
            <span>{workflowCoverTypeLabel(workflowType)} · 任务 #{String(run.serial || run.id || "").slice(-8)}</span>
          </div>
          <strong>{coverImages.length} 张结果</strong>
        </div>

        {message ? <p className={`workflow-cover-dialog-message-next ${/失败|错误|最多|缺少|请先|没有/.test(message) ? "error" : ""}`}>{message}</p> : null}

        <div className="workflow-cover-dialog-layout-next">
          <div className="workflow-cover-dialog-config-next">
            <section className="workflow-cover-dialog-section-next">
              <strong>图片配置</strong>
              <div className="workflow-cover-dialog-two-next">
                <label>
                  图片渠道
                  <select value={imageKey?.id || ""} onChange={(event) => updateImageKey(event.target.value)} disabled={generating}>
                    <option value="">请选择图片渠道</option>
                    {imageKeys.map((key) => <option value={key.id} key={key.id}>{apiKeyName(key)}</option>)}
                  </select>
                </label>
                <label>
                  图片模型
                  <select value={imageModel?.id || ""} onChange={(event) => updateImageModel(event.target.value)} disabled={!imageKey || generating}>
                    {imageModels.length
                      ? imageModels.map((model) => <option value={model.id} key={model.id}>{model.name || model.id}</option>)
                      : <option value="">请先选择渠道</option>}
                  </select>
                </label>
              </div>
              <div className="workflow-cover-dialog-output-next">
                <div>
                  <span>输出质量</span>
                  <div className="workflow-cover-dialog-resolutions-next">
                    {(imageModel?.resolutions || ["默认"]).map((item) => (
                      <button className={imageResolution === item ? "selected" : ""} type="button" onClick={() => setImageResolution(item)} disabled={!imageModel || generating} key={item}>
                        {coverResolutionLabel(item)}
                      </button>
                    ))}
                  </div>
                </div>
                <label>
                  生成数量
                  <select value={count} onChange={(event) => setCount(normalizeWorkflowCoverCount(event.target.value))} disabled={generating}>
                    {workflowCoverCountOptions.map((item) => <option value={item} key={item}>{item} 张</option>)}
                  </select>
                </label>
              </div>
              <div className="workflow-cover-dialog-dimension-head-next">
                <span>画面尺寸</span>
                <small>选择比例或像素尺寸</small>
              </div>
              <div className="workflow-cover-dialog-ratios-next">
                {ratioOptions.map((option) => (
                  <button className={ratio === option.value ? "selected" : ""} type="button" onClick={() => { setRatio(option.value); if (option.value !== "custom") setCustomSize(""); }} disabled={generating} key={option.value}>
                    {option.label}<small>{option.detail}</small>
                  </button>
                ))}
              </div>
              {ratio === "custom" ? (
                <label>
                  自定义尺寸
                  <input value={customSize} onChange={(event) => setCustomSize(event.target.value)} placeholder="例如 1280x1920" disabled={generating} />
                </label>
              ) : null}
            </section>

            <section className="workflow-cover-dialog-section-next">
              <div className="workflow-cover-dialog-section-head-next">
                <strong>参考内容</strong>
                <span>{selectedRoleImages.length}/{WORKFLOW_COVER_MAX_ROLE_IMAGES} 张角色图</span>
              </div>
              <label className="workflow-cover-dialog-check-next">
                <input type="checkbox" checked={includeContentReference} onChange={(event) => setIncludeContentReference(event.target.checked)} disabled={generating} />
                <span>
                  <strong>{workflowCoverContentReferenceLabel(workflowType)}</strong>
                </span>
              </label>
              <div className="workflow-cover-dialog-role-head-next">
                <span>角色图参考</span>
                <div>
                  <button type="button" onClick={selectAllRoleImages} disabled={!roleImages.length || generating}>全选</button>
                  <button type="button" onClick={() => setSelectedRoleImageIds([])} disabled={!selectedRoleImageIds.length || generating}>全不选</button>
                </div>
              </div>
              {roleImages.length ? (
                <div className="workflow-cover-dialog-role-grid-next">
                  {roleImages.map((image) => {
                    const selected = selectedRoleImageSet.has(image.id);
                    return (
                      <button className={selected ? "selected" : ""} type="button" onClick={() => toggleRoleImage(image.id)} disabled={generating} title={image.name} key={image.id}>
                        <img src={image.thumbnailUrl || image.url} alt={image.name} loading="lazy" />
                        <span>{selected ? "✓" : "+"}</span>
                      </button>
                    );
                  })}
                </div>
              ) : <p className="workflow-cover-dialog-muted-next">当前分镜结果没有可用角色资产，可直接生成。</p>}
            </section>

            <section className="workflow-cover-dialog-section-next">
              <div className="workflow-cover-dialog-section-head-next">
                <strong>封面提示词</strong>
                <span>系统方案和个人要求可叠加</span>
              </div>
              <label className="workflow-cover-dialog-check-next workflow-cover-dialog-system-check-next">
                <input type="checkbox" checked={includeSystemPrompt} onChange={(event) => setIncludeSystemPrompt(event.target.checked)} disabled={generating} />
                <span><strong>使用系统提示词</strong></span>
              </label>
              <div className="workflow-cover-dialog-import-next">
                <select value={promptAssetId} onChange={(event) => setPromptAssetId(event.target.value)} disabled={generating}>
                  <option value="">从提示词库选择</option>
                  {promptAssets.map((asset) => <option value={asset.id} key={asset.id}>{asset.name}</option>)}
                </select>
                <button type="button" onClick={importPrompt} disabled={!promptAssetId || generating}>导入</button>
              </div>
              <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={6} placeholder="填写你的封面要求，或从提示词库导入（选填）..." disabled={generating} />
            </section>
          </div>

          <div className="workflow-cover-dialog-results-next">
            <div className="workflow-cover-dialog-results-head-next">
              <div>
                <strong>生成效果</strong>
                <span>{generating ? `${generationProgress.done}/${generationProgress.total}` : `${coverImages.length} 张`}</span>
              </div>
              {generating ? <i><b style={{ width: `${Math.round((generationProgress.done / Math.max(generationProgress.total, 1)) * 100)}%` }}></b></i> : null}
            </div>
            {coverImages.length ? (
              <div className="workflow-cover-dialog-result-grid-next">
                {coverImages.map((image, index) => (
                  <article key={image.id || image.url}>
                    <button className="workflow-cover-dialog-preview-button-next" type="button" onClick={() => setPreviewImage({ ...image, index })} aria-label={`预览封面 ${index + 1}`}>
                      <img
                        src={image.thumbnailUrl || image.url}
                        alt={`封面 ${index + 1}`}
                        loading={index < 3 ? "eager" : "lazy"}
                        decoding="async"
                        fetchPriority={index < 3 ? "high" : "low"}
                      />
                    </button>
                    <div>
                      <span title={coverSizeLabel(image)}>{coverSizeLabel(image)}</span>
                      <p>
                        <a href={buildToolImageDownloadUrl({ url: image.url, fileName: `workflow-cover-${index + 1}.png` })}>下载</a>
                        <button type="button" onClick={() => deleteCover(image.id)} disabled={generating}>删除</button>
                      </p>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="workflow-cover-dialog-empty-next">
                <span>▧</span>
                <strong>还没有封面</strong>
                <p>完成左侧配置后开始生成。</p>
              </div>
            )}
          </div>
        </div>

        <div className="workflow-dialog-actions-next workflow-cover-dialog-actions-next">
          <button className="secondary-action compact" type="button" onClick={onClose} disabled={generating}>取消</button>
          <button className="primary-action compact" type="button" onClick={handleGenerate} disabled={generating || !imageKey || !imageModel || (!includeSystemPrompt && !prompt.trim())}>
            {generating ? `生成中 ${generationProgress.done}/${generationProgress.total}` : `生成 ${count} 张封面`}
          </button>
        </div>
        </section>
      </div>
      {previewImage ? (
        <div className="workflow-image-dialog-backdrop-next workflow-cover-preview-backdrop-next" role="presentation" onClick={() => setPreviewImage(null)}>
          <section className="workflow-image-preview-dialog-next workflow-cover-image-preview-next" role="dialog" aria-modal="true" aria-label="预览封面图片" onClick={(event) => event.stopPropagation()}>
            <button className="workflow-dialog-close-next" type="button" onClick={() => setPreviewImage(null)} aria-label="关闭预览">×</button>
            <img src={previewImage.url} alt={`封面 ${Number(previewImage.index || 0) + 1} 预览`} />
            <div>
              <strong>封面 {Number(previewImage.index || 0) + 1}</strong>
              <a className="secondary-action compact" href={buildToolImageDownloadUrl({ url: previewImage.url, fileName: `workflow-cover-${Number(previewImage.index || 0) + 1}.png` })}>下载图片</a>
            </div>
          </section>
        </div>
      ) : null}
    </>,
    document.body,
  );
}

function normalizeCoverRun(run = {}) {
  const result = objectValue(run.result);
  return { ...run, ...result, id: run.id || result.id || "", topic: run.topic || result.topic || "", result };
}

function preferredImageKey(imageKeys = [], workflow = {}) {
  return imageKeys.find((item) => item.id === workflow?.imageKeyId) || imageKeys[0] || null;
}

function preferredImageModel(models = [], workflow = {}) {
  return models.find((item) => item.id === workflow?.imageModelId || item.modelId === workflow?.imageModelId) || models[0] || null;
}

function preferredRatio(model = null, requested = "") {
  const ratios = coverRatioOptions(model);
  return ratios.find((item) => item.value === requested)?.value || ratios[0]?.value || "";
}

function coverImageModels(apiKey = null) {
  if (!apiKey) return [];
  const knownModels = imageModelsForApiKey(apiKey, { workflow: true });
  if (knownModels.length) return knownModels;
  return configuredImageModels(apiKey).map(({ modelId, name }) => {
    return {
      id: modelId,
      name: name || humanizeModelName(modelId),
      modelId,
      resolutions: ["默认"],
      ratios: defaultRatios(),
    };
  });
}

function configuredImageModels(apiKey = {}) {
  const structured = Array.isArray(apiKey.models) ? apiKey.models : Array.isArray(apiKey.modelOptions) ? apiKey.modelOptions : [];
  const structuredModels = structured.map((model) => typeof model === "string"
    ? { modelId: model, name: "" }
    : { modelId: model?.modelId || model?.id || "", name: model?.name || model?.label || "" }).filter((model) => model.modelId);
  if (structuredModels.length) return structuredModels;
  return String(apiKey.model || "").split(/[,，;\n]/).map((item) => item.trim()).filter(Boolean).map((modelId) => ({ modelId, name: "" }));
}

function humanizeModelName(modelId = "") {
  return String(modelId || "模型")
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => /^(?:gpt|ai|pro|v\d+|\d+(?:\.\d+)?k)$/i.test(part) ? part.toUpperCase() : `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function coverRatioOptions(model = null) {
  const ratios = Array.isArray(model?.ratios) && model.ratios.length ? model.ratios : defaultRatios();
  return ratios.map((item) => ({
    value: item.value || item.id || item,
    label: item.label || item.name || item.value || item,
    detail: item.detail || item.value || item.id || item,
  }));
}

function defaultRatios() {
  return [
    { value: "1:1", label: "正方形", detail: "1:1" },
    { value: "9:16", label: "竖屏", detail: "9:16" },
    { value: "16:9", label: "横屏", detail: "16:9" },
  ];
}

function optionValue(options = [], requested = "") {
  const values = Array.isArray(options) ? options : [];
  return values.includes(requested) ? requested : values[0] || "";
}

function coverResolutionLabel(value = "") {
  return {
    auto: "自动",
    default: "默认",
    low: "低",
    medium: "标准",
    high: "高",
  }[String(value || "").trim().toLowerCase()] || value || "默认";
}

function coverSizeLabel(image = {}) {
  const value = image.ratio === "custom"
    ? image.customSize || image.imageSize || "自定义尺寸"
    : image.ratio || image.customSize || image.imageSize || "封面图片";
  return String(value).replace(/(\d)\s*[x×*]\s*(\d)/gi, "$1×$2");
}

function pixelImageSize(value = "") {
  const normalized = String(value || "").trim().toLowerCase().replace(/\s+/g, "").replace(/[×*]/g, "x");
  return /^\d{3,4}x\d{3,4}$/.test(normalized) ? normalized : "";
}

function apiKeyName(apiKey = {}) {
  return apiKey.name || apiKey.channel || apiKey.serviceType || "未命名渠道";
}

function coverScript(run = {}) {
  return String(run.scriptOutput || run.script || run.content || "").trim();
}

function coverImagesFromRun(run = {}) {
  return Array.isArray(run.coverImages) ? run.coverImages.filter((item) => item?.url).map((item) => ({
    ...item,
    url: resolveFlowStudioFileUrl(item.url),
    thumbnailUrl: resolveFlowStudioFileUrl(item.thumbnailUrl || item.imageThumbnailUrl || item.thumbnail_url || item.thumbUrl || ""),
  })) : [];
}

function firstGeneratedImage(result = {}) {
  const imageObject = Array.isArray(result.imageObjects) ? result.imageObjects[0] : null;
  const rawImage = Array.isArray(result.images) ? result.images[0]
    : Array.isArray(result.resultImages) ? result.resultImages[0]
      : result.imageUrl || result.url || result.fileUrl || "";
  return {
    url: imageValue(imageObject) || imageValue(rawImage),
    thumbnailUrl: imageObject?.thumbnailUrl || imageObject?.imageThumbnailUrl || imageObject?.thumbnail_url || imageObject?.thumbUrl || "",
    thumbnailMimeType: imageObject?.thumbnailMimeType || imageObject?.thumbnail_mime_type || "",
  };
}

function imageValue(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value.url || value.imageUrl || value.fileUrl) return value.url || value.imageUrl || value.fileUrl;
  if (value.b64_json) return `data:image/png;base64,${value.b64_json}`;
  return "";
}

function validateGeneration(input = {}) {
  if (!input.imageKey) return "请选择图片渠道。";
  if (!input.imageModel) return "请选择图片模型。";
  if (!input.ratio) return "请选择图片比例或尺寸。";
  if (input.ratio === "custom" && !String(input.customSize || "").trim()) return "请填写自定义图片尺寸。";
  if (!String(input.prompt || "").trim()) return "请填写封面提示词。";
  const roleError = validateWorkflowCoverRoleCount(input.selectedRoleImages?.length || 0);
  if (roleError) return roleError;
  if (!input.includeContentReference) return "";
  const topic = String(input.run?.topic || "").trim();
  if (!topic) return ["story", "ecommerce"].includes(input.workflowType) ? "当前任务缺少选题大纲，请取消内容参考或先补齐选题。" : "当前任务缺少选题，请取消内容参考或先补齐选题。";
  if (!["story", "ecommerce"].includes(input.workflowType) && !coverScript(input.run)) return "当前任务缺少最终文案，请取消内容参考或先完成文案。";
  return "";
}

function normalizePromptAssets(result = {}) {
  return normalizeAssetResult(result).map((asset) => {
    const payload = objectValue(asset.payload);
    return {
      id: asset.id || payload.id || "",
      name: asset.name || asset.title || payload.name || payload.title || "未命名提示词",
      prompt: asset.prompt || asset.content || asset.text || payload.prompt || payload.content || payload.text || "",
    };
  }).filter((asset) => asset.id && asset.prompt);
}

function normalizeAssetResult(result = {}) {
  const direct = Array.isArray(result.assets) ? result.assets : [];
  const grouped = Array.isArray(result.groups) ? result.groups.flatMap((group) => [
    ...(Array.isArray(group.assets) ? group.assets : []),
    ...(Array.isArray(group.items) ? group.items : []),
    ...(Array.isArray(group.prompts) ? group.prompts : []),
  ]) : [];
  return [...direct, ...grouped];
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
