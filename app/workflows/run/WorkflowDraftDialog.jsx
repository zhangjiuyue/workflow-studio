"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { DRAFT_WATERMARK_TEXT_WIDTH_RATIO, draftWatermarkAnchor } from "../../../server/src/lib/workflow-draft-watermark.mjs";

export default function WorkflowDraftDialog({
  dialog,
  draftKeys = [],
  queueing = false,
  draftRunning = false,
  draftProgress = 0,
  draftProgressDetail = "",
  draftUrl = "",
  draftId = "",
  draftError = "",
  runLabel = "",
  previewImageUrl = "",
  onChange,
  onClose,
  onConfirm,
}) {
  const [mounted, setMounted] = useState(false);
  const [previewCornerIndex, setPreviewCornerIndex] = useState(0);
  const busy = queueing || draftRunning;
  const resultReady = Boolean(draftUrl) && !busy;
  const generationFailed = Boolean(draftError) && !busy;
  const normalizedProgress = Math.max(0, Math.min(100, Math.round(Number(draftProgress || 0))));
  const audioChoices = Array.isArray(dialog?.audioChoices) ? dialog.audioChoices : [];
  const materialChoices = Array.isArray(dialog?.materialChoices) ? dialog.materialChoices : [];
  const ratioChoices = Array.isArray(dialog?.ratioChoices) ? dialog.ratioChoices : [];
  const motionChoices = Array.isArray(dialog?.motionChoices) ? dialog.motionChoices : [];
  const scaleChoices = Array.isArray(dialog?.motionScaleChoices) ? dialog.motionScaleChoices : [];
  const selectedAudio = audioChoices.find((choice) => choice.id === dialog?.audioTrackId) || null;
  const selectedMaterial = materialChoices.find((choice) => choice.id === dialog?.materialSource) || null;
  const selectedRatio = ratioChoices.find((choice) => choice.id === dialog?.aspectRatio) || null;
  const selectedMotion = motionChoices.find((choice) => choice.id === dialog?.imageMotion) || null;
  const groupedAudioChoices = useMemo(() => groupAudioChoices(audioChoices), [audioChoices]);
  const watermarkEnabled = Boolean(dialog?.watermarkEnabled);
  const watermarkMode = watermarkModes.some((mode) => mode.id === dialog?.watermarkMode) ? dialog.watermarkMode : "corners";
  const watermarkModeLabel = watermarkModes.find((mode) => mode.id === watermarkMode)?.label || "四角自动轮换";
  const watermarkPosition = watermarkPositions.some((position) => position.id === dialog?.watermarkPosition)
    ? dialog.watermarkPosition
    : "bottom-right";
  const previewPosition = watermarkMode === "corners"
    ? watermarkPositions[previewCornerIndex % watermarkPositions.length].id
    : watermarkMode === "motion" ? "top-left" : watermarkPosition;
  const previewAnchor = draftWatermarkAnchor(previewPosition);
  const previewRatio = dialog?.aspectRatio === "9:16" ? "9 / 16" : dialog?.aspectRatio === "1:1" ? "1 / 1" : "16 / 9";
  const canSubmit = Boolean(
    dialog?.draftKeyId
    && selectedAudio
    && !selectedAudio.disabled
    && selectedMaterial
    && !selectedMaterial.disabled
    && selectedRatio
    && selectedMotion
    && (selectedMotion.id !== "zoom_in" || scaleChoices.some((choice) => choice.id === String(dialog?.imageMotionScale || "")))
    && (!watermarkEnabled || String(dialog?.watermarkText || "").trim())
  );

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!watermarkEnabled || watermarkMode !== "corners") {
      setPreviewCornerIndex(0);
      return undefined;
    }
    const timer = window.setInterval(() => {
      setPreviewCornerIndex((current) => (current + 1) % watermarkPositions.length);
    }, 1400);
    return () => window.clearInterval(timer);
  }, [watermarkEnabled, watermarkMode]);

  function update(field, value) {
    onChange?.((current) => current ? { ...current, [field]: value } : current);
  }

  function selectMaterial(materialSource) {
    onChange?.((current) => current ? {
      ...current,
      materialSource,
      ...(materialSource === "video" ? { imageMotion: "none" } : {}),
    } : current);
  }

  async function handleConfirm() {
    await onConfirm?.(dialog);
  }

  if (!mounted || typeof document === "undefined" || !dialog) return null;

  return createPortal(
    <div className="workflow-image-dialog-backdrop-next" role="presentation" onClick={queueing ? undefined : onClose}>
      <section className="workflow-image-retry-dialog-next workflow-draft-dialog-next" role="dialog" aria-modal="true" aria-label="生成剪辑草稿" onClick={(event) => event.stopPropagation()}>
        <button className="workflow-dialog-close-next" type="button" disabled={queueing} onClick={onClose} aria-label="关闭">×</button>
        <div className="workflow-draft-dialog-head-next">
          <div>
            <h3>生成剪辑草稿</h3>
            <p>配置音频时间轴、画面素材、画幅和素材效果后直接生成。</p>
          </div>
          <strong>{runLabel || "任务结果"}</strong>
        </div>

        <div className="workflow-draft-dialog-layout-next">
          <div className="workflow-draft-dialog-config-next">
            <section className="workflow-draft-dialog-section-next">
              <div className="workflow-draft-dialog-section-head-next">
                <strong>时间轴配置</strong>
                <span>音频 + 画面</span>
              </div>
              <label>
                剪辑草稿 API
                <select value={dialog.draftKeyId || ""} onChange={(event) => update("draftKeyId", event.target.value)} disabled={busy}>
                  <option value="">请选择剪辑草稿 API</option>
                  {draftKeys.map((key) => <option value={key.id} key={key.id}>{apiKeyDisplayName(key)}</option>)}
                </select>
                {!draftKeys.length ? <small className="error">请先在 API 设置中添加 管理员已启用的草稿服务 Key。</small> : null}
              </label>
              <label>
                音频时间轴
                <select value={dialog.audioTrackId || ""} onChange={(event) => update("audioTrackId", event.target.value)} disabled={busy}>
                  <option value="">请选择音频</option>
                  {groupedAudioChoices.map((group) => (
                    <optgroup label={group.label} key={group.id}>
                      {group.choices.map((choice) => (
                        <option value={choice.id} disabled={choice.disabled} key={choice.id}>{choice.label} · {choice.meta}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                {selectedAudio?.source === "music" ? (
                  <small>音乐库音频将作为主音轨，画面和字幕沿用当前任务的最终 SRT 时间轴。</small>
                ) : <small>可选中文音频、英文音频或已经上传并完成识别的音频。</small>}
              </label>
              <div>
                <span className="workflow-draft-dialog-field-label-next">画面素材</span>
                <div className="workflow-draft-material-grid-next">
                  {materialChoices.map((choice) => (
                    <button className={dialog.materialSource === choice.id ? "selected" : ""} type="button" disabled={busy || choice.disabled} onClick={() => selectMaterial(choice.id)} key={choice.id}>
                      <i>{choice.id === "video" ? "▶" : "▧"}</i>
                      <span><strong>{choice.label}</strong><small>{choice.meta}</small></span>
                    </button>
                  ))}
                </div>
                <small className="workflow-draft-dialog-help-next">{dialog.materialSource === "video"
                  ? "按视频时间线铺入全部已完成视频，并自动静音素材原声。"
                  : "按最终音频时间轴铺入分镜图片，可添加缓慢放大效果。"}</small>
              </div>
            </section>

            <section className="workflow-draft-dialog-section-next">
              <div className="workflow-draft-dialog-section-head-next">
                <strong>画面配置</strong>
                <span>{selectedRatio?.meta || "选择输出比例"}</span>
              </div>
              <div>
                <span className="workflow-draft-dialog-field-label-next">视频比例</span>
                <div className="workflow-draft-ratio-grid-next">
                  {ratioChoices.map((choice) => (
                    <button className={dialog.aspectRatio === choice.id ? "selected" : ""} type="button" disabled={busy} onClick={() => update("aspectRatio", choice.id)} key={choice.id}>
                      <strong>{choice.label}</strong><small>{choice.meta}</small>
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <span className="workflow-draft-dialog-field-label-next">素材效果</span>
                <div className="workflow-draft-motion-grid-next">
                  {motionChoices.map((choice) => (
                    <button className={dialog.imageMotion === choice.id ? "selected" : ""} type="button" disabled={busy || dialog.materialSource === "video"} onClick={() => update("imageMotion", choice.id)} key={choice.id}>
                      {choice.label}
                    </button>
                  ))}
                </div>
              </div>
              {dialog.materialSource === "image" && dialog.imageMotion === "zoom_in" ? (
                <div>
                  <span className="workflow-draft-dialog-field-label-next">放大幅度</span>
                  <div className="workflow-draft-scale-grid-next">
                    {scaleChoices.map((choice) => (
                      <button className={String(dialog.imageMotionScale) === choice.id ? "selected" : ""} type="button" disabled={busy} onClick={() => update("imageMotionScale", choice.id)} key={choice.id}>
                        {choice.label}×
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
              {dialog.materialSource === "video" ? <p className="workflow-draft-dialog-note-next">视频素材保留自身运动，不叠加图片缓慢放大效果。</p> : null}
            </section>

            <section className="workflow-draft-dialog-section-next workflow-draft-watermark-section-next">
              <div className="workflow-draft-dialog-section-head-next">
                <div>
                  <strong>文字水印</strong>
                  <small>仅使用手动填写的文字</small>
                </div>
                <button
                  className={`workflow-draft-watermark-switch-next${watermarkEnabled ? " selected" : ""}`}
                  type="button"
                  role="switch"
                  aria-checked={watermarkEnabled}
                  disabled={busy}
                  onClick={() => update("watermarkEnabled", !watermarkEnabled)}
                >
                  <i />
                  <span>{watermarkEnabled ? "已开启" : "未开启"}</span>
                </button>
              </div>
              {watermarkEnabled ? (
                <>
                  <label>
                    水印内容
                    <input
                      type="text"
                      maxLength={80}
                      value={dialog.watermarkText || ""}
                      placeholder="请输入要显示的水印文字"
                      disabled={busy}
                      onChange={(event) => update("watermarkText", event.target.value)}
                    />
                    <small>水印内容不会从任务标题、账号或其他位置自动读取。</small>
                  </label>
                  <div>
                    <span className="workflow-draft-dialog-field-label-next">显示方式</span>
                    <div className="workflow-draft-watermark-mode-grid-next">
                      {watermarkModes.map((mode) => (
                        <button className={watermarkMode === mode.id ? "selected" : ""} type="button" disabled={busy} onClick={() => update("watermarkMode", mode.id)} key={mode.id}>
                          <strong>{mode.label}</strong>
                          <small>{mode.meta}</small>
                        </button>
                      ))}
                    </div>
                  </div>
                  {watermarkMode === "fixed" ? (
                    <div>
                      <span className="workflow-draft-dialog-field-label-next">固定位置</span>
                      <div className="workflow-draft-watermark-position-grid-next">
                        {watermarkPositions.map((position) => (
                          <button className={watermarkPosition === position.id ? "selected" : ""} type="button" disabled={busy} onClick={() => update("watermarkPosition", position.id)} key={position.id}>
                            {position.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  <div className="workflow-draft-watermark-style-next">
                    <label>
                      字号
                      <select value={dialog.watermarkSize || "medium"} disabled={busy} onChange={(event) => update("watermarkSize", event.target.value)}>
                        <option value="small">小</option>
                        <option value="medium">中</option>
                        <option value="large">大</option>
                      </select>
                    </label>
                    <label>
                      颜色
                      <span className="workflow-draft-watermark-color-next">
                        <input type="color" value={dialog.watermarkColor || "#ffffff"} disabled={busy} onChange={(event) => update("watermarkColor", event.target.value)} />
                        <b>{String(dialog.watermarkColor || "#ffffff").toUpperCase()}</b>
                      </span>
                    </label>
                    <label>
                      不透明度
                      <span className="workflow-draft-watermark-opacity-next">
                        <input type="range" min="30" max="100" step="5" value={Number(dialog.watermarkOpacity || 70)} disabled={busy} onChange={(event) => update("watermarkOpacity", Number(event.target.value))} />
                        <b>{Number(dialog.watermarkOpacity || 70)}%</b>
                      </span>
                    </label>
                  </div>
                </>
              ) : (
                <p className="workflow-draft-dialog-note-next">开启后可配置手动文字水印，默认按视频时长在四个角落自动轮换。</p>
              )}
            </section>
          </div>

          <aside className="workflow-draft-watermark-preview-panel-next">
            <div className="workflow-draft-dialog-section-head-next">
              <strong>水印预览</strong>
              <span>{watermarkEnabled ? watermarkModeLabel : "未开启"}</span>
            </div>
            <div className={`workflow-draft-watermark-preview-stage-next ratio-${String(dialog.aspectRatio || "16:9").replace(":", "-")}`} style={{ aspectRatio: previewRatio }}>
              {previewImageUrl ? <img src={previewImageUrl} alt="分镜画面预览" /> : <div className="workflow-draft-watermark-preview-placeholder-next"><i>▧</i><span>画面效果示意</span></div>}
              <div className="workflow-draft-watermark-preview-shade-next" />
              {watermarkEnabled ? (
                <span
                  className={`workflow-draft-watermark-preview-text-next ${previewPosition} size-${dialog.watermarkSize || "medium"}${watermarkMode === "motion" ? " mode-motion" : ""}`}
                  style={{
                    color: dialog.watermarkColor || "#ffffff",
                    opacity: Number(dialog.watermarkOpacity || 70) / 100,
                    left: `${previewAnchor.x * 100}%`,
                    top: `${previewAnchor.y * 100}%`,
                    width: `${DRAFT_WATERMARK_TEXT_WIDTH_RATIO * 100}%`,
                  }}
                >
                  {String(dialog.watermarkText || "水印文字").trim() || "水印文字"}
                </span>
              ) : null}
            </div>
            <div className="workflow-draft-watermark-preview-copy-next">
              <strong>{watermarkEnabled ? "预览示意" : "开启水印后可预览"}</strong>
              <p>{watermarkEnabled
                ? watermarkMode === "corners"
                  ? "导出时会把水印分段放到不同角落，降低单侧画面被裁剪后水印消失的风险。"
                  : watermarkMode === "motion"
                    ? "导出时水印会沿两条交叉对角线持续缓慢移动，形成横向沙漏轨迹。"
                    : `导出时水印会固定显示在${watermarkPositions.find((position) => position.id === watermarkPosition)?.label || "右下角"}。`
                : "右侧只预览水印在画面中的大致位置和样式，不显示剪辑草稿结果。"}</p>
            </div>
            <dl className="workflow-draft-watermark-preview-meta-next">
              <div><dt>视频比例</dt><dd>{selectedRatio?.label || "16:9 横屏"}</dd></div>
              <div><dt>水印轨道</dt><dd>{watermarkEnabled ? "独立文字轨道" : "—"}</dd></div>
              <div><dt>显示方式</dt><dd>{watermarkEnabled ? watermarkModeLabel : "—"}</dd></div>
            </dl>
          </aside>
        </div>

        {busy ? (
          <div className="workflow-draft-generation-status-next" role="status" aria-live="polite">
            <div>
              <strong>{queueing ? "正在提交后台任务" : "正在后台生成剪辑草稿"}</strong>
              <span>{normalizedProgress}%</span>
            </div>
            <div className="workflow-draft-generation-progress-next" aria-hidden="true">
              <i style={{ width: `${Math.max(3, normalizedProgress)}%` }} />
            </div>
            <p>{draftProgressDetail || (queueing ? "正在保存配置并提交任务…" : "可以关闭弹窗，生成任务会继续在后台运行。")}</p>
          </div>
        ) : null}

        {resultReady ? (
          <div className="workflow-draft-result-ready-next" role="status" aria-live="polite">
            <div>
              <i>✓</i>
              <span>
                <strong>剪辑草稿已生成</strong>
                <small>{draftId ? `草稿 ID：${draftId}` : "可以打开并导入剪映。"}</small>
              </span>
            </div>
            <p>草稿链接已保存；关闭弹窗后，再次打开“生成剪辑草稿”仍可查看本次结果。</p>
          </div>
        ) : null}

        {draftError ? (
          <p className="workflow-draft-dialog-error-next">
            {draftError}
            {generationFailed ? <small>可以调整上方配置后重新生成草稿。</small> : null}
          </p>
        ) : null}

        <div className="workflow-dialog-actions-next workflow-draft-dialog-actions-next">
          <button className="secondary-action compact" type="button" disabled={queueing} onClick={onClose}>{busy || resultReady ? "关闭" : "取消"}</button>
          <div>
            {resultReady ? (
              <>
                <button className="secondary-action compact" type="button" disabled={!canSubmit} onClick={handleConfirm}>重新生成草稿</button>
                <a className="primary-action compact" href={draftUrl} target="_blank" rel="noreferrer">打开剪辑草稿</a>
              </>
            ) : (
              <button className="primary-action compact" type="button" disabled={busy || !canSubmit} onClick={handleConfirm}>
                {queueing ? "正在提交" : draftRunning ? `后台生成中 ${normalizedProgress}%` : generationFailed ? "重新生成草稿" : "生成剪辑草稿"}
              </button>
            )}
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}

function groupAudioChoices(choices = []) {
  const groups = [
    { id: "workflow", label: "任务音频", choices: choices.filter((choice) => choice.source !== "music") },
    { id: "music", label: "音乐库", choices: choices.filter((choice) => choice.source === "music") },
  ];
  return groups.filter((group) => group.choices.length);
}

function apiKeyDisplayName(key = {}) {
  return key.name || key.channel || key.endpoint || "未命名渠道";
}

const watermarkModes = [
  { id: "corners", label: "四角自动轮换", meta: "默认 · 防裁剪" },
  { id: "fixed", label: "固定角落", meta: "全程保持位置" },
  { id: "motion", label: "动态效果", meta: "平滑缓慢移动" },
];

const watermarkPositions = [
  { id: "top-left", label: "左上角" },
  { id: "top-right", label: "右上角" },
  { id: "bottom-right", label: "右下角" },
  { id: "bottom-left", label: "左下角" },
];
