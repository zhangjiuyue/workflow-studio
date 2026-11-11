"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createPortal } from "react-dom";
import { buildImageZipDownloadUrl, confirmWorkflowTopics, createFileZipJob, createImageZipJob, deleteFileZipJob, deleteImageZipJob, downloadToolImage, executeWorkflowTopics, generateAudio, generateText, getFileZipJob, getImageZipJob, getWorkflow, getWorkflowRun, getWorkflowTopicConfirmationStatus, listApiKeys, listAssets, queueWorkflowNode, queueWorkflowVideoTasks, queryVideoToolTask, readAuthToken, resolveFlowStudioFileUrl, saveAsset, transcribeAudio, updateWorkflow, updateWorkflowRun, uploadAssetFiles, watermarkToolImage } from "../../../lib/flowstudio-api";
import { apiKeysForService } from "../../../lib/api-key-options";
import SavedAudioVoicePicker from "../../../components/SavedAudioVoicePicker";
import { mergeAudioModelOptions } from "../../../lib/audio-model-options";
import { imageModelsForApiKey } from "../../../lib/image-model-options";
import { llmModelsForApiKey } from "../../../lib/llm-model-options";
import { videoGenerationModels as workflowVideoModels, videoModelsForApiKey } from "../../../lib/video-model-options";
import { isTalkingVideoWorkflow, orderWorkflowStageIds, workflowNodeActiveStatus, workflowSupportsRoleOutfitVariantDetection } from "../../../lib/workflow-stage-policy.mjs";
import { resolveWorkflowAudioGenerationSettings } from "../../../lib/workflow-audio-settings.mjs";
import { workflowAudioProgressView } from "../../../lib/workflow-audio-progress.mjs";
import { splitWorkflowTopicTranslation } from "../../../lib/workflow-topic-display.mjs";
import { buildWorkflowVideoPromptSaveState, safeWorkflowVideoDownloadName, sortWorkflowVideoAssetsByFileName, workflowVideoMaterialImagePath, workflowVideoTimelineItemId as workflowTimelineItemId } from "../../../lib/workflow-video-prompt.mjs";
import { buildWorkflowAiDirectorVideoPrompt, workflowAiDirectorErrorMessage, workflowAiDirectorTimelineTaskView, workflowStoryboardReadyForVideoTimeline, workflowVideoTimelineHasAiDirectorOutput } from "../../../lib/workflow-ai-video-prompt.mjs";
import { findWorkflowVideoResultInList, mergeWorkflowVideoResultLists, upsertWorkflowVideoResult, workflowRunForRefresh, workflowVideoResultInstanceId, workflowVideoResultsHaveActiveTask } from "../../../lib/workflow-video-results.mjs";
import { createBrowserImagePackage } from "../../../lib/browser-image-package.mjs";
import { buildWorkflowComplianceHighlights, buildWorkflowCompliancePrompt, normalizeWorkflowComplianceIssues } from "../../../lib/workflow-compliance.mjs";
import { useLanguage } from "../../../components/LanguageProvider";
import WorkflowCoverDialog from "./WorkflowCoverDialog";
import WorkflowDraftDialog from "./WorkflowDraftDialog";
import {
  defaultWorkflowRoleImageStyleId,
  normalizeWorkflowRoleImageStyleId,
  stripWorkflowRoleImageStyle,
  workflowRoleImageStyleOptions,
} from "../../../lib/workflow-role-image-style.mjs";

const pendingWorkflowScriptRunsKey = "flowstudio:pending-workflow-script-runs";
const pendingWorkflowScriptRunTtlMs = 2 * 60 * 1000;
const workflowRoleNameWatermarkVersion = "noto-sans-sc-path-v3";
const workflowVideoBatchSubmitId = "__workflow_video_batch__";
const workflowAudioFormats = ["mp3", "wav", "opus"];
const workflowAudioRequestMaxChars = 1100;
const workflowAudioEmotions = [
  { value: "natural", label: "自然" },
  { value: "happy", label: "愉悦" },
  { value: "sad", label: "低沉" },
  { value: "angry", label: "有力" },
];
const workflowAudioVoiceModes = [
  { id: "default", name: "默认音色", description: "使用模型默认声音，适合快速生成。" },
  { id: "clone", name: "克隆音色", description: "使用工作流配置里的参考音频随文克隆。" },
  { id: "saved", name: "已克隆音色", description: "填写 音频服务 已保存的 reference_id。" },
];
export default function WorkflowRunDetailDashboard() {
  const searchParams = useSearchParams();
  const runId = searchParams.get("runId") || "";
  const [run, setRun] = useState(null);
  const [workflow, setWorkflow] = useState(null);
  const [apiKeys, setApiKeys] = useState([]);
  const [visualStyles, setVisualStyles] = useState([]);
  const [musicAssets, setMusicAssets] = useState([]);
  const [loadState, setLoadState] = useState(runId ? "loading" : "error");
  const [message, setMessage] = useState(runId ? "正在读取任务..." : "缺少任务 ID。");
  const loadingRunRef = useRef(false);

  async function loadRun(options = {}) {
    if (!runId) return;
    if (options.silent && loadingRunRef.current) return;
    loadingRunRef.current = true;
    if (!options.silent) {
      setLoadState("loading");
      setMessage("正在读取任务...");
    }
    try {
      const result = await getWorkflowRun(runId);
      const nextRun = normalizeWorkflowRun(result.run || result.workflowRun || result);
      setRun((current) => workflowRunForRefresh(current, nextRun));
      if (nextRun.workflowId && (!workflow || workflow.id !== nextRun.workflowId)) {
        loadWorkflowConfig(nextRun.workflowId, nextRun);
      }
      if (!options.silent) {
        setLoadState("ready");
        setMessage("任务已同步。");
      }
    } catch (error) {
      if (options.silent) return;
      setLoadState("error");
      setMessage(error.message || "任务读取失败。");
    } finally {
      loadingRunRef.current = false;
    }
  }

  async function loadWorkflowConfig(workflowId, runForSnapshot = null) {
    try {
      const snapshot = workflowSnapshotFromRun(runForSnapshot || {});
      if (Object.keys(snapshot).length) {
        setWorkflow(normalizeWorkflowConfigForRun(snapshot, runForSnapshot));
      }
      const [workflowResult, apiResult, visualResult, musicResult] = await Promise.allSettled([
        Object.keys(snapshot).length ? Promise.resolve(null) : getWorkflow(workflowId),
        listApiKeys(),
        listAssets("visual-style"),
        listAssets("music"),
      ]);
      const found = workflowResult.status === "fulfilled" ? workflowResult.value?.workflow : null;
      if (found) setWorkflow(normalizeWorkflowConfigForRun(found, runForSnapshot));
      if (apiResult.status === "fulfilled" && Array.isArray(apiResult.value?.apiKeys)) {
        setApiKeys(apiResult.value.apiKeys);
      }
      if (visualResult.status === "fulfilled" && Array.isArray(visualResult.value?.assets)) {
        setVisualStyles(normalizeWorkflowVisualStyles(visualResult.value.assets));
      }
      if (musicResult.status === "fulfilled" && Array.isArray(musicResult.value?.assets)) {
        setMusicAssets(normalizeWorkflowMusicAssets(musicResult.value.assets));
      }
    } catch {
      setWorkflow(null);
    }
  }

  useEffect(() => {
    if (!runId) return;
    if (!readAuthToken()) {
      setLoadState("error");
      setMessage("请先登录后查看任务。");
      return;
    }
    let active = true;
    loadRun().then(() => {
      if (!active) return;
    });
    return () => {
      active = false;
    };
  }, [runId]);

  useEffect(() => {
    if (!run || !workflowRunHasLiveJob(run)) return undefined;
    const timer = window.setInterval(() => {
      loadRun({ silent: true });
    }, 5000);
    return () => window.clearInterval(timer);
  }, [run, runId]);

  if (loadState === "loading") {
    return (
      <section className="workflow-panel-next workflow-run-page-next workflow-run-focused-next workflow-run-loading-next">
        <span className="workflow-refresh-spinner-next" aria-hidden="true"></span>
        <div>
          <strong>正在读取任务</strong>
          <p>正在同步最新选题和运行结果。</p>
        </div>
      </section>
    );
  }

  if (loadState === "error" || !run) {
    return (
      <section className="workflow-panel-next workflow-run-page-next workflow-run-focused-next">
        <div className="workflow-run-page-head">
          <div>
            <p className="eyebrow">Run Detail</p>
            <h2>任务读取失败</h2>
            <p>{message}</p>
          </div>
          <Link className="secondary-action" href="/workflows">
            返回工作流
          </Link>
        </div>
      </section>
    );
  }

  const summary = workflowRunSummary(run);

  if (isTopicConfirmationRun(run)) {
    return <TopicConfirmationPage run={run} workflow={workflow} summary={summary} onRefresh={() => loadRun({ silent: true })} onRunChange={setRun} />;
  }

  return (
    <RunResultPage run={run} workflow={workflow} apiKeys={apiKeys} visualStyles={visualStyles} musicAssets={musicAssets} summary={summary} onRefresh={() => loadRun({ silent: true })} onRunChange={setRun} />
  );
}

function TopicConfirmationPage({ run, workflow, summary, onRefresh, onRunChange }) {
  const router = useRouter();
  const topics = workflowTopicOptions(run, summary);
  const workflowForType = workflow || normalizeWorkflowConfigForRun(null, run);
  const ecommerceWorkflow = isStoryboardWorkflow(workflowForType);
  const talkingVideoWorkflow = isTalkingVideoWorkflow(workflowForType);
  const [selectedIndexes, setSelectedIndexes] = useState(() => workflowDefaultSelectedIndexes(run, topics));
  const [editingTopicIndex, setEditingTopicIndex] = useState(-1);
  const [editingTopicValue, setEditingTopicValue] = useState("");
  const [submittingAction, setSubmittingAction] = useState("");
  const [notice, setNotice] = useState("");
  const submitting = Boolean(submittingAction);
  const title = workflowRunOwnerName(run);
  const topicGenerating = run.topicGenerationStatus === "running" || run.stages?.topic === "running" || run.status === "running";
  const confirmedTopicSet = new Set(uniqueWorkflowTextList(run.confirmedTopics || []).map(normalizeWorkflowTopicTitle));
  const confirmedTopicSignature = Array.from(confirmedTopicSet).join("|");
  const executableTopicCount = topics.filter((topic) => !confirmedTopicSet.has(normalizeWorkflowTopicTitle(topic))).length;
  const executableIndexes = selectedIndexes.filter((index) => !confirmedTopicSet.has(normalizeWorkflowTopicTitle(topics[index])));
  const selectedCount = executableIndexes.length;
  const pendingExecutionChildren = workflowPendingTopicExecutionChildren(run);
  const confirmedCount = confirmedTopicSet.size;

  useEffect(() => {
    setSelectedIndexes(workflowDefaultSelectedIndexes(run, topics));
    setEditingTopicIndex(-1);
    setEditingTopicValue("");
  }, [run.id, topics.join("|"), confirmedTopicSignature]);

  useEffect(() => {
    setNotice("");
  }, [run.id]);

  async function handleConfirmTopics() {
    const selectedTopics = executableIndexes.map((index) => topics[index]).filter(Boolean);
    if (!selectedTopics.length || submitting) return;
    const topicAdaptations = ecommerceWorkflow ? workflowTopicAdaptationsForTopics(run, selectedTopics) : {};
    setSubmittingAction("confirm");
    setNotice("正在保存选中的选题...");
    try {
      const payload = {
        topics: selectedTopics,
        confirmedTopics: selectedTopics,
        confirmedTopicIndexes: executableIndexes,
        ...(ecommerceWorkflow ? { topicAdaptations } : {}),
        ...(ecommerceWorkflow && run.topicAdaptationBrief ? { topicAdaptationBrief: run.topicAdaptationBrief } : {}),
        autoQueueScript: false,
      };
      const result = await withWorkflowUiTimeout(
        (options) => confirmWorkflowTopics(run.id, payload, options),
        20000,
        "选题确认请求超时，已恢复按钮并刷新状态，请确认是否已创建子任务后再重试。",
      );
      if (result?.run) onRunChange(normalizeWorkflowRun(result.run));
      setNotice("选题已确认。请点击“执行下一步”开始生成文案。");
    } catch (error) {
      setNotice(error.message || "选题确认失败。");
      if (error?.workflowUiTimeout) {
        await refreshTopicConfirmationAfterTimeout(run, selectedTopics, {
          onRunChange,
          setNotice,
        });
      }
    } finally {
      setSubmittingAction("");
    }
  }

  async function handleExecuteTopics() {
    if (!pendingExecutionChildren.length || submitting) return;
    const childIds = pendingExecutionChildren.map((child) => child.id).filter(Boolean);
    setSubmittingAction("execute");
    setNotice(workflowExecutionStepSubmittingText(workflow));
    try {
      const result = await withWorkflowUiTimeout(
        (options) => executeWorkflowTopics(run.id, { childIds }, options),
        20000,
        "执行请求超时，已恢复按钮并刷新状态，请确认任务状态后再重试。",
      );
      rememberPendingWorkflowScriptRuns(result, run);
      if (result?.run) onRunChange(normalizeWorkflowRun(result.run));
      setNotice(workflowExecutionStepQueuedNotice(workflow));
      router.push(workflowBackHref(result?.run || run));
    } catch (error) {
      setNotice(error.message || "执行选题失败。");
      if (error?.workflowUiTimeout) {
        await refreshTopicExecutionAfterTimeout(run, childIds, {
          onRunChange,
          router,
          setNotice,
        });
      }
    } finally {
      setSubmittingAction("");
    }
  }

  function toggleTopic(index, topic) {
    if (editingTopicIndex >= 0 || confirmedTopicSet.has(normalizeWorkflowTopicTitle(topic)) || submitting) return;
    setSelectedIndexes((current) => (
      current.includes(index) ? current.filter((item) => item !== index) : [...current, index].sort((a, b) => a - b)
    ));
  }

  function selectAllTopics() {
    if (submitting) return;
    setSelectedIndexes(topics
      .map((topic, index) => (confirmedTopicSet.has(normalizeWorkflowTopicTitle(topic)) ? -1 : index))
      .filter((index) => index >= 0));
  }

  function startEditTopic(event, index, topic) {
    event.stopPropagation();
    if (submitting || confirmedTopicSet.has(normalizeWorkflowTopicTitle(topic))) return;
    setEditingTopicIndex(index);
    setEditingTopicValue(topic);
    setNotice("");
  }

  async function saveTopicEdit(event, index, oldTopic) {
    event.stopPropagation();
    const nextTopic = editingTopicValue.trim();
    if (!nextTopic) {
      setNotice("选题不能为空。");
      return;
    }
    setSubmittingAction("edit");
    setNotice("正在保存选题...");
    try {
      const generatedTopics = Array.isArray(run.generatedTopics) && run.generatedTopics.length
        ? [...run.generatedTopics]
        : [...topics];
      generatedTopics[index] = nextTopic;
      const replaceTopicValue = (value) => (
        typeof value === "string" && normalizeWorkflowTopicTitle(value) === normalizeWorkflowTopicTitle(oldTopic)
          ? nextTopic
          : value
      );
      const selectedTopics = Array.isArray(run.selectedTopics) ? run.selectedTopics.map(replaceTopicValue) : [];
      const confirmedTopics = Array.isArray(run.confirmedTopics) ? run.confirmedTopics.map(replaceTopicValue) : [];
      const topicAdaptations = ecommerceWorkflow ? renameWorkflowTopicAdaptation(run, oldTopic, nextTopic) : {};
      const result = await updateWorkflowRun(run.id, {
        result: workflowRunResultSnapshot(run, {
          generatedTopics,
          selectedTopics,
          confirmedTopics,
          ...(ecommerceWorkflow ? { topicAdaptations } : {}),
          topicGenerationStatus: run.topicGenerationStatus || "done",
          topicGenerationError: "",
        }),
      });
      const updatedRun = normalizeWorkflowRun(result?.run || {
        ...run,
        generatedTopics,
        selectedTopics,
        confirmedTopics,
        ...(ecommerceWorkflow ? { topicAdaptations } : {}),
      });
      onRunChange(updatedRun);
      setEditingTopicIndex(-1);
      setEditingTopicValue("");
      setNotice("选题已保存。");
      await onRefresh();
    } catch (error) {
      setNotice(error.message || "选题保存失败。");
    } finally {
      setSubmittingAction("");
    }
  }

  function cancelTopicEdit(event) {
    event.stopPropagation();
    setEditingTopicIndex(-1);
    setEditingTopicValue("");
    setNotice("");
  }

  return (
    <section className="workflow-panel-next workflow-run-page-next workflow-run-focused-next workflow-topic-confirm-page-next">
      <div className="workflow-run-focused-head-next">
        <Link className="secondary-action compact workflow-run-back-next" href={workflowBackHref(run)}>
          ← 返回任务
        </Link>
        <div className="workflow-run-title-cluster-next">
          <span className="workflow-run-icon-next">◎</span>
          <div>
            <h2>{title} · 选题确认</h2>
            <p>选择要继续执行的选题，确认后会形成多条并行制作线。</p>
          </div>
        </div>
        <div className="workflow-run-header-action-row-next workflow-topic-confirm-actions-next">
          <button
            className="secondary-action compact"
            type="button"
            disabled={topicGenerating || !executableIndexes.length || submitting}
            onClick={handleConfirmTopics}
          >
            {submittingAction === "confirm" ? "确认中" : "确认选题"}
          </button>
          <button
            className="primary-action compact"
            type="button"
            disabled={topicGenerating || !pendingExecutionChildren.length || submitting}
            onClick={handleExecuteTopics}
          >
            {submittingAction === "execute" ? "执行中" : "执行下一步"}
          </button>
        </div>
      </div>

      <div className="workflow-topic-toolbar-next">
        <strong>{topicGenerating ? "正在生成选题..." : `已确认 ${confirmedCount} 个；待确认已选择 ${selectedCount} / ${executableTopicCount} 个`}</strong>
        <button className="secondary-action compact" type="button" disabled={!executableTopicCount || submitting} onClick={selectAllTopics}>
          全选选题
        </button>
      </div>
      {notice ? <p className="workflow-run-page-message workflow-topic-confirm-notice-next">{notice}</p> : null}

      {topicGenerating && !topics.length ? (
        <article className="workflow-topic-loading-card-next">
          <span className="workflow-refresh-spinner-next" aria-hidden="true"></span>
          <div>
            <strong>正在生成候选选题</strong>
            <p>后台正在执行选题节点，完成后会自动刷新到这里。</p>
          </div>
        </article>
      ) : topics.length ? (
        <div className={`workflow-topic-confirm-list-next ${ecommerceWorkflow ? "ecommerce" : "compact"}`}>
          {topics.map((topic, index) => (
            <TopicConfirmationItem
              key={`${topic}-${index}`}
              index={index}
              topic={topic}
              adaptation={ecommerceWorkflow ? workflowTopicAdaptationFor(run, topic) : ""}
              ecommerceWorkflow={ecommerceWorkflow}
              showTranslationTooltip={talkingVideoWorkflow}
              selected={selectedIndexes.includes(index) || confirmedTopicSet.has(normalizeWorkflowTopicTitle(topic))}
              confirmed={confirmedTopicSet.has(normalizeWorkflowTopicTitle(topic))}
              executionStatus={workflowTopicExecutionStatus(run, topic)}
              submitting={submitting}
              editing={editingTopicIndex === index}
              editingTopicValue={editingTopicValue}
              onToggle={() => toggleTopic(index, topic)}
              onEdit={(event) => startEditTopic(event, index, topic)}
              onCancel={cancelTopicEdit}
              onSave={(event) => saveTopicEdit(event, index, topic)}
              onEditingValueChange={setEditingTopicValue}
            />
          ))}
        </div>
      ) : (
        <p className="workflow-run-page-message">这条选题任务还没有可展示的候选选题。</p>
      )}
    </section>
  );
}

function TopicConfirmationItem({
  index,
  topic,
  adaptation,
  ecommerceWorkflow,
  showTranslationTooltip,
  selected,
  confirmed,
  executionStatus,
  submitting,
  editing,
  editingTopicValue,
  onToggle,
  onEdit,
  onCancel,
  onSave,
  onEditingValueChange,
}) {
  const topicDisplay = showTranslationTooltip
    ? splitWorkflowTopicTranslation(topic)
    : { title: topic, translation: "" };
  const translationTooltipId = topicDisplay.translation ? `workflow-topic-translation-${index}` : undefined;

  return (
    <article
      className={selected ? "selected" : ""}
      onClick={onToggle}
    >
      <span>{String(index + 1).padStart(2, "0")}</span>
      {editing ? (
        <textarea
          className="workflow-topic-input-next"
          value={editingTopicValue}
          onChange={(event) => onEditingValueChange(event.target.value)}
          onClick={(event) => event.stopPropagation()}
          rows={ecommerceWorkflow ? 6 : 3}
          autoFocus
        />
      ) : (
        <div className="workflow-topic-copy-next">
          <strong
            className={topicDisplay.translation ? "workflow-topic-translation-trigger-next" : undefined}
            tabIndex={topicDisplay.translation ? 0 : undefined}
            aria-describedby={translationTooltipId}
            onClick={topicDisplay.translation ? (event) => event.stopPropagation() : undefined}
          >
            {topicDisplay.title}
            {topicDisplay.translation ? (
              <span id={translationTooltipId} className="workflow-topic-translation-tooltip-next" role="tooltip">
                <b>中文释义</b>
                {topicDisplay.translation}
              </span>
            ) : null}
          </strong>
          {adaptation ? (
            <p>
              <b>改编思路</b>
              {adaptation}
            </p>
          ) : null}
        </div>
      )}
      <div className="workflow-topic-edit-actions-next">
        {editing ? (
          <>
            <button className="secondary-action compact" type="button" onClick={onCancel}>
              取消
            </button>
            <button className="primary-action compact" type="button" disabled={submitting} onClick={onSave}>
              保存
            </button>
          </>
        ) : confirmed ? (
          <span className={`workflow-topic-done-pill-next ${executionStatus === "error" ? "error" : ""}`}>
            {workflowTopicExecutionLabel(executionStatus)}
          </span>
        ) : (
          <button className="workflow-topic-edit-next" type="button" disabled={submitting} onClick={onEdit} aria-label={`编辑 ${topic}`}>
            ✎
          </button>
        )}
      </div>
    </article>
  );
}

function workflowExecutionStepSubmittingText(workflow = {}) {
  const step = workflowExecutionStep(workflow);
  if (step === "all") return "正在创建文案任务，完成后会继续生成分镜和图片...";
  if (step === "shot") return "正在创建文案任务，完成后会继续生成分镜...";
  return "正在创建文案任务...";
}

function workflowExecutionStepQueuedNotice(workflow = {}) {
  const step = workflowExecutionStep(workflow);
  if (step === "all") return "选题已确认，文案生成正在后台排队，完成后会继续生成分镜和图片。";
  if (step === "shot") return "选题已确认，文案生成正在后台排队，完成后会继续生成分镜。";
  return "选题已确认，文案生成正在后台排队。";
}

function workflowExecutionStep(workflow = {}) {
  return ["story", "shot", "all"].includes(workflow.executionStep) ? workflow.executionStep : "story";
}

async function refreshTopicConfirmationAfterTimeout(run, selectedTopics, { onRunChange, setNotice }) {
  try {
    const result = await withWorkflowUiTimeout(
      (options) => getWorkflowTopicConfirmationStatus(run.id, options),
      8000,
      "选题状态查询超时。",
    );
    const nextRun = normalizeWorkflowRun(result?.run || result);
    if (nextRun?.id) onRunChange(nextRun);
    const confirmedTopicSet = new Set(uniqueWorkflowTextList(nextRun?.confirmedTopics || []).map(normalizeWorkflowTopicTitle));
    const childTopicSet = new Set((nextRun?.children || []).map((child) => normalizeWorkflowTopicTitle(child?.topic)).filter(Boolean));
    const selectedTopicSet = selectedTopics.map(normalizeWorkflowTopicTitle).filter(Boolean);
    const alreadyConfirmed = selectedTopicSet.some((topic) => confirmedTopicSet.has(topic) || childTopicSet.has(topic));
    if (alreadyConfirmed) {
      setNotice("选题已经确认成功。请点击“执行下一步”开始生成文案。");
      return;
    }
  } catch {
    // Keep the timeout message if the status refresh also fails.
  }
  setNotice("选题确认请求超时，已恢复按钮。请先刷新状态确认没有创建子任务后再重试。");
}

async function refreshTopicExecutionAfterTimeout(run, childIds, { onRunChange, router, setNotice }) {
  try {
    const result = await withWorkflowUiTimeout(
      (options) => getWorkflowTopicConfirmationStatus(run.id, options),
      8000,
      "选题执行状态查询超时。",
    );
    const nextRun = normalizeWorkflowRun(result?.run || result);
    if (nextRun?.id) onRunChange(nextRun);
    const requestedIds = new Set(childIds);
    const requestedChildren = (nextRun?.children || []).filter((child) => requestedIds.has(child?.id));
    const executionStarted = requestedChildren.some((child) => !workflowTopicChildPendingExecution(child));
    if (executionStarted) {
      rememberPendingWorkflowScriptRuns({ ...result, children: requestedChildren }, nextRun || run);
      setNotice("文案任务已经开始执行，正在返回任务页。");
      router.push(workflowBackHref(nextRun || run));
      return;
    }
  } catch {
    // Keep the recovered-button message if the bounded status refresh also fails.
  }
  setNotice("执行请求超时，按钮已恢复；当前没有发现已启动的文案任务，可以安全重试。");
}

function workflowPendingTopicExecutionChildren(run = {}) {
  const confirmedTopics = new Set(uniqueWorkflowTextList(run.confirmedTopics || []).map(normalizeWorkflowTopicTitle));
  return (Array.isArray(run.children) ? run.children : []).filter((child) => (
    confirmedTopics.has(normalizeWorkflowTopicTitle(child?.topic)) && workflowTopicChildPendingExecution(child)
  ));
}

function workflowTopicChildPendingExecution(child = {}) {
  const status = String(child?.stages?.script || "").trim().toLowerCase();
  return !status || ["pending", "waiting"].includes(status);
}

function workflowTopicExecutionStatus(run, topic) {
  const topicKey = normalizeWorkflowTopicTitle(topic);
  const child = (Array.isArray(run?.children) ? run.children : [])
    .find((item) => normalizeWorkflowTopicTitle(item?.topic) === topicKey);
  if (!child) return "confirmed";
  const status = String(child?.stages?.script || "").trim().toLowerCase();
  if (["queued", "running"].includes(status)) return "running";
  if (status === "done") return "done";
  if (["error", "canceled"].includes(status) || child?.status === "error") return "error";
  return "confirmed";
}

function workflowTopicExecutionLabel(status) {
  if (status === "running") return "执行中";
  if (status === "done") return "已执行";
  if (status === "error") return "执行失败";
  return "已确认";
}

async function withWorkflowUiTimeout(request, timeoutMs, message) {
  if (typeof window === "undefined") {
    return typeof request === "function" ? request({}) : request;
  }
  const requestFactory = typeof request === "function" ? request : () => request;
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  let timedOut = false;
  let timeoutId = 0;
  timeoutId = window.setTimeout(() => {
    timedOut = true;
    if (controller) controller.abort();
  }, timeoutMs);
  try {
    return await requestFactory(controller ? { signal: controller.signal } : {});
  } catch (error) {
    if (timedOut || error?.name === "AbortError" || error?.cause?.name === "AbortError") {
      const timeoutError = new Error(message);
      timeoutError.workflowUiTimeout = true;
      timeoutError.cause = error;
      throw timeoutError;
    }
    throw error;
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
  }
}

function rememberPendingWorkflowScriptRuns(result, parentRun) {
  if (typeof window === "undefined") return;
  const children = Array.isArray(result?.children)
    ? result.children
    : Array.isArray(result?.run?.children)
      ? result.run.children
      : [];
  const childIds = children.map((child) => child?.id).filter(Boolean);
  if (!childIds.length) return;
  const now = Date.now();
  const existing = readPendingWorkflowScriptRunEntries(now);
  const nextChildIds = new Set(childIds);
  const nextEntries = [
    ...existing.filter((entry) => !entry.childIds?.some((id) => nextChildIds.has(id))),
    {
      workflowId: parentRun?.workflowId || result?.run?.workflowId || "",
      parentRunId: parentRun?.id || result?.run?.id || "",
      childIds,
      expiresAt: now + pendingWorkflowScriptRunTtlMs,
    },
  ];
  try {
    window.sessionStorage.setItem(pendingWorkflowScriptRunsKey, JSON.stringify(nextEntries));
  } catch {
    // This is only an optimistic UI hint; confirmation must not depend on it.
  }
}

function readPendingWorkflowScriptRunEntries(now = Date.now()) {
  if (typeof window === "undefined") return [];
  try {
    const entries = JSON.parse(window.sessionStorage.getItem(pendingWorkflowScriptRunsKey) || "[]");
    return Array.isArray(entries) ? entries.filter((entry) => Number(entry?.expiresAt || 0) > now) : [];
  } catch {
    return [];
  }
}

function RunResultPage({ run, workflow, apiKeys, visualStyles, musicAssets, summary, onRefresh, onRunChange }) {
  const { language: readingLanguage } = useLanguage();
  const workflowForType = workflow || normalizeWorkflowConfigForRun(null, run);
  const ecommerceWorkflow = isStoryboardWorkflow(workflowForType);
  const talkingVideoWorkflow = isTalkingVideoWorkflow(workflowForType);
  const allowRoleOutfitVariantDetection = workflowSupportsRoleOutfitVariantDetection(workflowForType);
  const title = run.kind === "topic-child" && ecommerceWorkflow ? workflowTopicTitleOnly(run.topic) : run.topic || run.name || "未命名任务";
  const tabs = workflowResultTabs(workflowForType);
  const [activeTab, setActiveTab] = useState("script");
  const safeActiveTab = tabs.some((tab) => tab.id === activeTab) ? activeTab : tabs[0]?.id || "script";
  const [queueingScript, setQueueingScript] = useState(false);
  const [savingScript, setSavingScript] = useState(false);
  const [queueingAudio, setQueueingAudio] = useState(false);
  const [savingAudio, setSavingAudio] = useState(false);
  const [savingShot, setSavingShot] = useState(false);
  const [translatingScript, setTranslatingScript] = useState(false);
  const [checkingCompliance, setCheckingCompliance] = useState(false);
  const [optimizingScript, setOptimizingScript] = useState(false);
  const [queueingShot, setQueueingShot] = useState(false);
  const [queueingImages, setQueueingImages] = useState(false);
  const [downloadingImages, setDownloadingImages] = useState(false);
  const [watermarkingRoleImageIds, setWatermarkingRoleImageIds] = useState([]);
  const [restoringRoleImageIds, setRestoringRoleImageIds] = useState([]);
  const [roleWatermarkDialog, setRoleWatermarkDialog] = useState(null);
  const [imagePackageJob, setImagePackageJob] = useState(null);
  const [videoGroupingDialog, setVideoGroupingDialog] = useState(null);
  const [videoGenerateDialog, setVideoGenerateDialog] = useState(null);
  const [videoTimelineTask, setVideoTimelineTask] = useState(null);
  const [videoPackageJob, setVideoPackageJob] = useState(null);
  const [browserVideoPackageJob, setBrowserVideoPackageJob] = useState(null);
  const [videoResultPackageJob, setVideoResultPackageJob] = useState(null);
  const [packagingVideoMaterials, setPackagingVideoMaterials] = useState(false);
  const [browserPackagingVideoMaterials, setBrowserPackagingVideoMaterials] = useState(false);
  const [submittingVideoSegmentId, setSubmittingVideoSegmentId] = useState("");
  const [downloadingVideoResults, setDownloadingVideoResults] = useState(false);
  const [queryingVideoResultIds, setQueryingVideoResultIds] = useState([]);
  const [queueingDraft, setQueueingDraft] = useState(false);
  const [actionMessage, setActionMessage] = useState("");
  const [imageSelectionActive, setImageSelectionActive] = useState(false);
  const [selectedImageIds, setSelectedImageIds] = useState([]);
  const [imagePreview, setImagePreview] = useState(null);
  const [imageRetryDialog, setImageRetryDialog] = useState(null);
  const [manualOutfitDialog, setManualOutfitDialog] = useState(null);
  const [savingManualOutfit, setSavingManualOutfit] = useState(false);
  const [matchingManualOutfit, setMatchingManualOutfit] = useState(false);
  const [actionDialog, setActionDialog] = useState(null);
  const [coverDialogOpen, setCoverDialogOpen] = useState(false);
  const [draftDialog, setDraftDialog] = useState(null);
  const [editingVideoPromptId, setEditingVideoPromptId] = useState("");
  const [videoPromptDraft, setVideoPromptDraft] = useState("");
  const [savingVideoPromptId, setSavingVideoPromptId] = useState("");
  const [savingImagePromptId, setSavingImagePromptId] = useState("");
  const [uploadingProductImageId, setUploadingProductImageId] = useState("");
  const [uploadingRoleImageId, setUploadingRoleImageId] = useState("");
  const actionResolverRef = useRef(null);
  const pollingVideoResultIdsRef = useRef(new Set());
  const deletedVideoResultIdsRef = useRef(new Set());
  const videoPersistQueueRef = useRef(Promise.resolve());
  const runRef = useRef(run);
  const summaryRef = useRef(summary);
  const videoResultsRef = useRef(Array.isArray(summary.videoResults) ? summary.videoResults : []);
  const scriptRunning = workflowNodeIsRunning(run, "script");
  const audioRunning = workflowNodeIsRunning(run, "audio");
  const shotRunning = workflowNodeIsRunning(run, "shot");
  const imageRunning = workflowNodeIsRunning(run, "image");
  const videoPromptRunning = workflowNodeIsRunning(run, "videoPrompt");
  const videoPromptBackendJob = run.backendJobs?.videoPrompt || {};
  const videoPromptFailed = run.stages?.videoPrompt === "error" || videoPromptBackendJob.status === "error";
  const videoPromptDone = run.stages?.videoPrompt === "done" || videoPromptBackendJob.status === "done";
  const videoPromptError = workflowAiDirectorErrorMessage(
    stringFromWorkflowValue(run.videoPromptError || videoPromptBackendJob.error),
  );
  const displayedVideoTimelineTask = workflowAiDirectorTimelineTaskView({
    localTask: videoTimelineTask,
    running: videoPromptRunning,
    progress: videoPromptBackendJob.progress,
    failed: videoPromptFailed,
    error: videoPromptError,
    backendJobId: videoPromptBackendJob.id,
  });
  const draftRunning = workflowNodeIsRunning(run, "draft");
  const draftGenerationStateRef = useRef({ runId: run.id, running: draftRunning });
  const missingImageShots = workflowMissingImageShots(run);
  const hasShotResult = Boolean(summary.shotOutput || summary.shots.length || workflowParsedShotOutput(run).length);
  const imageNodeComplete = workflowImageNodeComplete(run, summary);
  const hasAudioResult = Boolean(summary.audioTracks.length || summary.audioUrl || summary.audioSegments.length);
  const optimizationBusy = optimizingScript || checkingCompliance;
  const canQueueScript = !scriptRunning && !queueingScript && !optimizationBusy;
  const canEditScript = Boolean(summary.script) && !workflowRunHasLiveJob(run) && !savingScript && !optimizationBusy;
  const canQueueAudio = !ecommerceWorkflow && (talkingVideoWorkflow || imageNodeComplete) && Boolean(workflowFinalScriptText(summary)) && !audioRunning && !queueingAudio && !optimizationBusy;
  const canEditShot = hasShotResult && !workflowRunHasLiveJob(run) && !savingShot && !optimizationBusy;
  const canQueueShot = Boolean(summary.script) && (!talkingVideoWorkflow || hasAudioResult) && !shotRunning && !queueingShot && !optimizationBusy;
  const canQueueImages = hasShotResult && !imageRunning && !queueingImages && !optimizationBusy;
  const imageKeys = apiKeysForService(apiKeys, "image");
  const llmKeys = apiKeysForService(apiKeys, "llm");
  const audioKeys = apiKeysForService(apiKeys, "audio");
  const videoKeys = apiKeysForService(apiKeys, "video");
  const draftKeys = apiKeysForService(apiKeys, "draft");
  const visualStylePayload = workflowVisualStylePayload(workflow, visualStyles);

  useEffect(() => {
    runRef.current = run;
    summaryRef.current = summary;
    videoResultsRef.current = Array.isArray(summary.videoResults) ? summary.videoResults : [];
  }, [run, summary]);

  useEffect(() => {
    if (!tabs.some((tab) => tab.id === activeTab)) setActiveTab(tabs[0]?.id || "script");
  }, [activeTab, tabs]);

  useEffect(() => {
    const previous = draftGenerationStateRef.current;
    if (previous.runId === run.id && previous.running && !draftRunning) {
      if (summary.draftUrl) {
        setActionMessage("剪辑草稿已生成，打开“生成剪辑草稿”弹窗即可查看结果。");
      } else if (summary.draftError) {
        setActionMessage(summary.draftError);
      }
    }
    draftGenerationStateRef.current = { runId: run.id, running: draftRunning };
  }, [run.id, draftRunning, summary.draftUrl, summary.draftError]);

  useEffect(() => {
    if (videoTimelineTask?.mode !== "ai-director" || videoTimelineTask.status !== "running" || videoPromptRunning) return;
    const taskJobId = stringFromWorkflowValue(videoTimelineTask.jobId);
    const backendJobId = stringFromWorkflowValue(run.backendJobs?.videoPrompt?.id);
    const failureBelongsToCurrentTask = !taskJobId || !backendJobId || taskJobId === backendJobId;
    if ((videoPromptError || videoPromptFailed) && failureBelongsToCurrentTask) {
      const failureMessage = videoPromptError || "AI 导演视频提示词组装失败。";
      setVideoTimelineTask((current) => current?.mode === "ai-director" ? {
        ...current,
        status: "error",
        progress: 100,
        detail: failureMessage,
        error: failureMessage,
      } : current);
      setActionMessage(failureMessage);
      return;
    }
    if (
      videoPromptDone
      && failureBelongsToCurrentTask
      && summary.videoTimeline.length
      && summary.videoTimeline.every((item) => stringFromWorkflowValue(item.videoPrompt).trim())
    ) {
      const successMessage = `已组装 ${summary.videoTimeline.length} 条 AI 导演视频提示词。`;
      setVideoTimelineTask((current) => current?.mode === "ai-director" ? {
        ...current,
        status: "done",
        progress: 100,
        done: summary.videoTimeline.length,
        total: summary.videoTimeline.length,
        detail: `已组装 ${summary.videoTimeline.length} 条 AI 导演视频提示词`,
      } : current);
      setActionMessage(successMessage);
    }
  }, [run.id, run.backendJobs?.videoPrompt?.id, videoPromptDone, videoPromptError, videoPromptFailed, videoPromptRunning, summary.videoTimeline, videoTimelineTask?.jobId, videoTimelineTask?.mode, videoTimelineTask?.status]);

  useEffect(() => {
    const generatedIds = new Set((run.shots || [])
      .filter((shot) => workflowShotImageUrl(shot))
      .map(workflowShotId)
      .filter(Boolean));
    setSelectedImageIds((current) => current.filter((id) => generatedIds.has(id)));
    if (!generatedIds.size) setImageSelectionActive(false);
  }, [run.id, summary.imageShots.length, summary.shots.length]);

  useEffect(() => {
    setImagePackageJob(workflowImagePackageFromRun(run));
    setDownloadingImages(false);
    setVideoGroupingDialog(null);
    setVideoGenerateDialog(null);
    setVideoTimelineTask(null);
    setVideoPackageJob(null);
    setVideoResultPackageJob(workflowVideoResultPackageFromRun(run));
    setPackagingVideoMaterials(false);
    setSubmittingVideoSegmentId("");
    setDownloadingVideoResults(false);
    setQueryingVideoResultIds([]);
    pollingVideoResultIdsRef.current.clear();
    deletedVideoResultIdsRef.current.clear();
    videoPersistQueueRef.current = Promise.resolve();
    setQueueingAudio(false);
    setSavingAudio(false);
    setWatermarkingRoleImageIds([]);
    setRestoringRoleImageIds([]);
    setRoleWatermarkDialog(null);
    setManualOutfitDialog(null);
    setSavingManualOutfit(false);
    setMatchingManualOutfit(false);
    setQueueingDraft(false);
    setUploadingProductImageId("");
    setEditingVideoPromptId("");
    setVideoPromptDraft("");
    setSavingVideoPromptId("");
    setActionDialog(null);
    setCoverDialogOpen(false);
    setDraftDialog(null);
    if (actionResolverRef.current) {
      actionResolverRef.current(null);
      actionResolverRef.current = null;
    }
  }, [run.id]);

  useEffect(() => {
    const pendingVideos = (Array.isArray(summary.videoResults) ? summary.videoResults : [])
      .filter((video) => {
        const videoId = workflowVideoResultId(video);
        return (!videoId || !deletedVideoResultIdsRef.current.has(videoId))
          && workflowVideoResultNeedsPolling(video);
      });
    if (!pendingVideos.length) return undefined;
    const syncPendingVideos = () => {
      pendingVideos.forEach((video) => {
        const videoId = workflowVideoResultId(video);
        if (!videoId || pollingVideoResultIdsRef.current.has(videoId)) return;
        pollingVideoResultIdsRef.current.add(videoId);
        syncWorkflowVideoResult(video, { background: true }).finally(() => {
          pollingVideoResultIdsRef.current.delete(videoId);
        });
      });
    };
    syncPendingVideos();
    const timer = window.setInterval(syncPendingVideos, 10000);
    return () => window.clearInterval(timer);
  }, [run.id, summary.videoResults]);

  function requestActionDialog(dialog) {
    if (actionResolverRef.current) {
      actionResolverRef.current(null);
      actionResolverRef.current = null;
    }
    return new Promise((resolve) => {
      actionResolverRef.current = resolve;
      setActionDialog(dialog);
    });
  }

  function closeActionDialog(value = null) {
    const resolver = actionResolverRef.current;
    actionResolverRef.current = null;
    setActionDialog(null);
    if (resolver) resolver(value);
  }

  function openScriptRegenerateDialog() {
    if (!canQueueScript) return;
    const defaultApi = llmKeys.find((key) => key.id === (workflow?.llmKeyId || "")) || llmKeys[0] || null;
    const models = workflowLlmModelOptions(defaultApi);
    setActionDialog({
      mode: "script",
      title: "重新生成文案",
      summary: "会清空后续已经生成或报错的节点结果，并把它们恢复为未完成状态。",
      hint: "确认后会重新执行文案节点，可临时切换 LLM 渠道和模型。",
      apiType: "llm",
      apiId: defaultApi?.id || "",
      modelId: models.some((model) => model.id === workflow?.storyModelId) ? workflow.storyModelId : models[0]?.id || "",
      confirmText: "确认生成",
    });
  }

  function openComplianceCheckDialog() {
    if (!summary.script || optimizationBusy || workflowRunHasLiveJob(run)) return;
    const defaultApi = llmKeys.find((key) => key.id === (workflow?.llmKeyId || "")) || llmKeys[0] || null;
    const models = workflowLlmModelOptions(defaultApi);
    setActionDialog({
      mode: "compliance",
      title: "违规风险检测",
      summary: "选择本次检测使用的 LLM 渠道和模型。检测只生成风险报告，不会修改当前文案。",
      hint: "模型会按红灯和黄灯规则逐项检查，并返回对应原文、原因和修改建议。",
      apiType: "llm",
      apiId: defaultApi?.id || "",
      modelId: models.some((model) => model.id === workflow?.storyModelId) ? workflow.storyModelId : models[0]?.id || "",
      confirmText: "开始检测",
    });
  }

  function openOptimizationDialog(customPrompt) {
    const instruction = String(customPrompt || "").trim();
    if (!summary.script || !instruction || optimizationBusy || workflowRunHasLiveJob(run)) return;
    const defaultApi = llmKeys.find((key) => key.id === (workflow?.llmKeyId || "")) || llmKeys[0] || null;
    const models = workflowLlmModelOptions(defaultApi);
    const versions = workflowOptimizationVersions(run, summary.script);
    const nextVersionNumber = Math.max(0, ...versions.map((version) => Number(version.number) || 0)) + 1;
    setActionDialog({
      mode: "optimization",
      title: `生成 V${nextVersionNumber}`,
      summary: "选择本次自定义优化使用的 LLM 渠道和模型。生成结果会成为新的当前版本。",
      hint: instruction,
      customPrompt: instruction,
      apiType: "llm",
      apiId: defaultApi?.id || "",
      modelId: models.some((model) => model.id === workflow?.storyModelId) ? workflow.storyModelId : models[0]?.id || "",
      confirmText: `生成 V${nextVersionNumber}`,
    });
  }

  function openShotRegenerateDialog() {
    if (!canQueueShot) return;
    const defaultApi = llmKeys.find((key) => key.id === (workflow?.llmKeyId || "")) || llmKeys[0] || null;
    const models = workflowLlmModelOptions(defaultApi);
    const defaultImageApi = imageKeys.find((key) => key.id === (workflow?.imageKeyId || "")) || imageKeys[0] || null;
    const imageModels = workflowImageModelOptions(defaultImageApi);
    const defaultImageModelId = imageModels.some((model) => model.id === workflow?.imageModelId) ? workflow.imageModelId : imageModels[0]?.id || "";
    const defaultImageModel = imageModels.find((model) => model.id === defaultImageModelId) || imageModels[0] || null;
    const imageResolution = optionValueOrFirst(defaultImageModel?.resolutions || [], workflow?.imageResolution || "");
    const imageRatioOptions = workflowImageRatioOptions(defaultImageModel);
    const ratio = optionValueOrFirst(imageRatioOptions.map((option) => option.value), workflow?.ratio || "");
    const outfitRatio = optionValueOrFirst(imageRatioOptions.map((option) => option.value), "1:1") || ratio;
    setActionDialog({
      mode: "shot",
      storyboardMode: isStoryboardWorkflow(workflowForType) && summary.storyboardMode === "ai-director" ? "ai-director" : "traditional",
      allowAiDirectorStoryboard: isStoryboardWorkflow(workflowForType),
      maxDurationSeconds: summary.aiDirectorMaxDurationSeconds === 10 ? 10 : 15,
      title: hasShotResult ? "重新生成分镜" : "继续生成分镜",
      summary: hasShotResult
        ? talkingVideoWorkflow
          ? "会清空后续已经生成或报错的图片、视频提示和视频结果，并把它们恢复为未完成状态；已生成音频会保留。"
          : "会清空后续已经生成或报错的图片、音频、视频提示和视频结果，并把它们恢复为未完成状态。"
        : "会基于当前文案生成分镜；需要图片时可勾选分镜完成后自动生成图片。",
      hint: "默认仅执行分镜节点；勾选图片生成后，会在分镜完成后继续生成图片。",
      apiType: "llm",
      autoImages: false,
      talkingVideoWorkflow,
      talkingShotSegmentationMode: talkingVideoWorkflow ? "duration-semantic" : "",
      roleOutfitVariantDetection: false,
      allowRoleOutfitVariantDetection,
      apiId: defaultApi?.id || "",
      modelId: models.some((model) => model.id === (workflow?.shotModelId || workflow?.storyModelId)) ? (workflow.shotModelId || workflow.storyModelId) : models[0]?.id || "",
      outfitDetectionLlmKeyId: defaultApi?.id || "",
      outfitDetectionModelId: models.some((model) => model.id === (workflow?.shotModelId || workflow?.storyModelId)) ? (workflow.shotModelId || workflow.storyModelId) : models[0]?.id || "",
      imageKeyId: defaultImageApi?.id || "",
      imageModelId: defaultImageModelId,
      imageResolution,
      ratio,
      imageSize: workflow?.imageSize || workflowImageRequestSize(ratio),
      customSize: workflow?.customSize || "",
      outfitImageKeyId: defaultImageApi?.id || "",
      outfitImageModelId: defaultImageModelId,
      outfitImageResolution: imageResolution,
      outfitImageRatio: outfitRatio,
      outfitImageSize: workflowImageRequestSize(outfitRatio),
      outfitImageCustomSize: "",
      confirmText: "确认生成",
    });
  }

  function openDraftExportDialog() {
    if (queueingDraft) return;
    const audioChoices = workflowDraftAudioChoices(summary, musicAssets);
    const defaultDraftKey = draftKeys[0] || null;
    const materialChoices = workflowDraftMaterialChoices(summary);
    const defaultMaterial = materialChoices.find((choice) => !choice.disabled && choice.id === "video")
      || materialChoices.find((choice) => !choice.disabled)
      || materialChoices[0];
    const ratioChoices = workflowDraftRatioChoices();
    const motionChoices = workflowDraftImageMotionChoices();
    const motionScaleChoices = workflowDraftImageMotionScaleChoices();
    const activeDraftPayload = objectFromWorkflowValue(run.backendJobs?.draft?.payload);
    const previousConfig = Object.keys(activeDraftPayload).length
      ? activeDraftPayload
      : objectFromWorkflowValue(summary.draftConfig);
    const previousAudioId = String(previousConfig.audioSourceId || previousConfig.audioTrackId || "");
    const previousMaterial = String(previousConfig.materialSource || "");
    const previousRatio = String(previousConfig.aspectRatio || "");
    const previousMotion = String(previousConfig.imageMotion || previousConfig.image_motion || "");
    const previousScale = String(previousConfig.imageMotionScale || previousConfig.image_motion_scale || "");
    const previousWatermark = objectFromWorkflowValue(previousConfig.watermark);
    const previousWatermarkMode = String(previousWatermark.mode || previousConfig.watermarkMode || "");
    const selectedMaterialSource = materialChoices.find((choice) => choice.id === previousMaterial && !choice.disabled)?.id
      || defaultMaterial?.id
      || "image";
    setDraftDialog({
      draftKeyId: draftKeys.find((key) => key.id === previousConfig.draftKeyId)?.id || defaultDraftKey?.id || "",
      audioChoices,
      audioTrackId: audioChoices.find((choice) => choice.id === previousAudioId && !choice.disabled)?.id
        || audioChoices.find((choice) => !choice.disabled)?.id
        || "",
      materialChoices,
      materialSource: selectedMaterialSource,
      ratioChoices,
      aspectRatio: ratioChoices.find((choice) => choice.id === previousRatio)?.id || ratioChoices[0]?.id || "16:9",
      motionChoices,
      imageMotion: selectedMaterialSource === "video"
        ? "none"
        : motionChoices.find((choice) => choice.id === previousMotion)?.id
        || motionChoices.find((choice) => choice.id === "zoom_in")?.id
        || "none",
      motionScaleChoices,
      imageMotionScale: motionScaleChoices.find((choice) => choice.id === previousScale)?.id
        || motionScaleChoices.find((choice) => choice.id === "1.06")?.id
        || "1.06",
      watermarkEnabled: Boolean(previousWatermark.enabled ?? previousConfig.watermarkEnabled ?? false),
      watermarkText: String(previousWatermark.text || previousConfig.watermarkText || ""),
      watermarkMode: ["fixed", "motion"].includes(previousWatermarkMode) ? previousWatermarkMode : "corners",
      watermarkPosition: ["top-left", "top-right", "bottom-right", "bottom-left"].includes(previousWatermark.position || previousConfig.watermarkPosition)
        ? previousWatermark.position || previousConfig.watermarkPosition
        : "bottom-right",
      watermarkSize: ["small", "medium", "large"].includes(previousWatermark.size || previousConfig.watermarkSize)
        ? previousWatermark.size || previousConfig.watermarkSize
        : "medium",
      watermarkColor: /^#[0-9a-f]{6}$/i.test(previousWatermark.color || previousConfig.watermarkColor || "")
        ? previousWatermark.color || previousConfig.watermarkColor
        : "#ffffff",
      watermarkOpacity: Math.min(100, Math.max(30, Number(previousWatermark.opacity ?? previousConfig.watermarkOpacity ?? 70) || 70)),
    });
  }

  function openAudioGenerateDialog(options = {}) {
    if (!canQueueAudio) return;
    const scripts = workflowAudioScriptChoices(summary, workflow);
    const defaultAudioKey = audioKeys.find((key) => key.id === (workflow?.audioKeyId || "")) || audioKeys[0] || null;
    const audioModels = workflowAudioModelOptions(defaultAudioKey);
    const requestedVariants = firstWorkflowArray(options.audioVariants, options.variants);
    const defaultVariants = requestedVariants.length
      ? requestedVariants
      : scripts.filter((item) => item.available).slice(0, 1).map((item) => item.variant);
    const audioVariants = defaultVariants.filter((variant) => scripts.some((item) => item.variant === variant && item.available));
    const hasGeneratedAudio = requestedVariants.length
      ? audioVariants.some((variant) => workflowAudioVariantHasGeneratedTrack(summary, variant))
      : workflowAudioHasAnyGeneratedTrack(summary);
    if (!hasGeneratedAudio) {
      setActionDialog({
        mode: "audio-confirm",
        title: "生成口播音频",
        summary: "将使用工作流表单中已配置的音频渠道、模型和音色生成音频。",
        target: audioVariants.map(workflowAudioTrackLabel).join("、") || "音频节点",
        label: "音频版本",
        hint: "首次生成无需重新选择模型或音色；生成后会保存音频、时间戳和 SRT。",
        audioVariants,
        confirmText: "确认生成",
      });
      return;
    }
    setActionDialog({
      mode: "audio",
      title: "生成口播音频",
      summary: "音频始终根据原文案生成；理解翻译不会作为音频输入。",
      target: "音频节点",
      hint: "生成后会保存音频、时间戳和 SRT；已有生成音频时会先确认是否替换。",
      audioChoices: scripts,
      audioVariants,
      audioKeyId: defaultAudioKey?.id || "",
      audioModelId: audioModels.some((model) => model.id === workflow?.audioModelId) ? workflow.audioModelId : audioModels[0]?.id || "",
      audioFormat: workflow?.audioFormat || "mp3",
      audioEmotion: workflow?.audioEmotion || "natural",
      audioBitrate: workflow?.audioBitrate || 128,
      audioSpeed: workflow?.audioSpeed || 1,
      audioVoice: workflow?.audioVoice || "alloy",
      audioVoicePresetId: workflow?.audioVoicePresetId || "default",
      audioReferenceId: workflow?.audioReferenceId || "",
      audioReferences: workflow?.audioReferences || [],
      confirmText: "确认生成",
    });
  }

  async function handleQueueScript(options = {}) {
    if (queueingScript || scriptRunning) return;
    setQueueingScript(true);
    setActionMessage("正在提交文案生成任务...");
    setActiveTab("script");
    try {
      const queueResult = await queueWorkflowNode(run.id, "script", {
        workflowId: run.workflowId,
        title: "文案生成",
        payload: {
          forceRegenerate: true,
          source: "manual-regenerate",
          llmKeyId: options.llmKeyId || workflow?.llmKeyId || "",
          storyModelId: options.storyModelId || options.modelId || workflow?.storyModelId || "",
          modelId: options.modelId || options.storyModelId || workflow?.storyModelId || "",
        },
      });
      const backendJobs = objectFromWorkflowValue(run.backendJobs);
      const updated = await updateWorkflowRun(run.id, {
        status: "running",
        completedAt: "",
        stages: {
          ...(run.stages || {}),
          topic: run.kind === "topic-child" ? "skipped" : run.stages?.topic || "done",
          outline: "skipped",
          script: "running",
          optimize: talkingVideoWorkflow ? "skipped" : "pending",
          audio: "pending",
          shot: "pending",
          image: "pending",
          videoPrompt: "pending",
          video: "pending",
          draft: "pending",
        },
        result: workflowRunResultSnapshot(run, workflowResetAfterScriptResult({
          scriptOutput: "",
          scriptError: "",
          backendJobs: {
            ...backendJobs,
            script: queueResult?.job || backendJobs.script,
          },
        })),
        error: "",
      });
      if (updated?.run) onRunChange(normalizeWorkflowRun(updated.run));
      await onRefresh();
      setActionMessage("文案生成已进入队列，完成后会自动刷新。");
    } catch (error) {
      setActionMessage(error.message || "文案生成任务提交失败。");
    } finally {
      setQueueingScript(false);
    }
  }

  async function handleSaveScript(nextScript) {
    const script = String(nextScript || "").trim();
    if (!script || savingScript || workflowRunHasLiveJob(run)) return;
    const confirmed = await requestActionDialog({
      mode: "confirm",
      title: "保存文案修改",
      summary: "保存文案修改会清空后续已经生成或报错的节点结果，并把它们恢复为未完成状态。",
      target: title,
      hint: "确认后会保留新的文案，并重置音频、分镜、图片和视频等后续节点。",
      confirmText: "确认保存",
      tone: "danger",
    });
    if (!confirmed) return;
    setSavingScript(true);
    setActionMessage("正在保存文案修改...");
    try {
      const updated = await updateWorkflowRun(run.id, {
        status: run.status === "error" ? "waiting" : run.status,
        stages: {
          ...(run.stages || {}),
          topic: run.kind === "topic-child" ? "skipped" : run.stages?.topic || "done",
          outline: "skipped",
          script: "done",
          optimize: talkingVideoWorkflow ? "skipped" : "pending",
          audio: "pending",
          shot: "pending",
          image: "pending",
          videoPrompt: "pending",
          video: "pending",
          draft: "pending",
        },
        result: workflowRunResultSnapshot(run, workflowResetAfterScriptResult({
          scriptOutput: script,
          scriptError: "",
        })),
        error: "",
      });
      if (updated?.run) onRunChange(normalizeWorkflowRun(updated.run));
      await onRefresh();
      setActionMessage("文案已保存，后续节点已恢复为未完成。");
    } catch (error) {
      setActionMessage(error.message || "文案保存失败。");
      throw error;
    } finally {
      setSavingScript(false);
    }
  }

  async function handleTranslateScript() {
    if (!summary.script || translatingScript) return false;
    const targetLanguage = workflowReadingLanguage(readingLanguage);
    const targetLabel = workflowTranslationTargetLabel(targetLanguage);
    if (workflowConfiguredLanguage(workflowForType) === targetLanguage) {
      setActionMessage(`原文案已是${targetLabel}，无需生成理解对照。`);
      return false;
    }
    const model = workflowForType?.storyModelId || "";
    if (!workflowForType?.llmKeyId || !model) {
      setActionMessage("请先在工作流配置里选择文案创意 LLM 渠道和第一步模型。");
      return false;
    }
    setTranslatingScript(true);
    setActionMessage(`正在生成${targetLabel}理解对照...`);
    let runningRun = run;
    try {
      const runningUpdate = await updateWorkflowRun(run.id, {
        result: workflowRunResultSnapshot(run, {
          scriptTranslation: summary.translationLanguage === targetLanguage ? summary.optimizedScript : "",
          scriptTranslationStatus: "running",
          scriptTranslationError: "",
          scriptTranslationLanguage: targetLanguage,
        }),
      });
      runningRun = normalizeWorkflowRun(runningUpdate?.run || run);
      if (runningUpdate?.run) onRunChange(runningRun);
      const translation = await requestWorkflowTranslation(workflowForType, summary.script, "script", targetLanguage);
      const updated = await updateWorkflowRun(run.id, {
        result: workflowRunResultSnapshot(runningRun, {
          scriptTranslation: translation,
          scriptTranslationStatus: "done",
          scriptTranslationError: "",
          scriptTranslationLanguage: targetLanguage,
        }),
      });
      if (updated?.run) onRunChange(normalizeWorkflowRun(updated.run));
      await onRefresh();
      setActionMessage(`${targetLabel}理解对照已生成，不会影响音频和后续节点。`);
      return true;
    } catch (error) {
      const message = error.message || "翻译失败。";
      const updated = await updateWorkflowRun(run.id, {
        result: workflowRunResultSnapshot(runningRun, {
          scriptTranslationStatus: "error",
          scriptTranslationError: message,
          scriptTranslationLanguage: targetLanguage,
        }),
      }).catch(() => null);
      if (updated?.run) onRunChange(normalizeWorkflowRun(updated.run));
      setActionMessage(message);
      return false;
    } finally {
      setTranslatingScript(false);
    }
  }

  async function handleCheckCompliance(options = {}) {
    if (!summary.script || checkingCompliance || workflowRunHasLiveJob(run)) return false;
    const apiKeyId = options.llmKeyId || workflowForType?.llmKeyId || "";
    const model = options.modelId || workflowForType?.storyModelId || "";
    if (!apiKeyId || !model) {
      setActionMessage("请先在工作流配置里选择文案创意 LLM 渠道和第一步模型。");
      return false;
    }
    setCheckingCompliance(true);
    setActionMessage("正在检测违规风险...");
    const previousOptimizeStatus = run.stages?.optimize || "pending";
    let runningRun = run;
    try {
      const runningUpdate = await updateWorkflowRun(run.id, {
        status: "running",
        stages: { ...(run.stages || {}), optimize: "running" },
        resultPatch: { optimizationStatus: "running", optimizationError: "", optimizePreviousStatus: previousOptimizeStatus },
      });
      runningRun = normalizeWorkflowRun(runningUpdate?.run || run);
      if (runningUpdate?.run) onRunChange(runningRun);
      const report = await requestWorkflowComplianceReview({ ...workflowForType, llmKeyId: apiKeyId, storyModelId: model }, summary.script);
      const versions = workflowOptimizationVersions(run, summary.script);
      const activeVersion = workflowActiveOptimizationVersion(run, versions, summary.script);
      const checkedAt = new Date().toISOString();
      const complianceReport = {
        status: report.issues.some((issue) => issue.level === "red") ? "red" : report.issues.length ? "yellow" : "clear",
        checkedAt,
        checkedText: summary.script,
        apiKeyId,
        modelId: model,
        issues: report.issues,
      };
      const nextVersions = versions.map((version) => version.id === activeVersion.id ? { ...version, complianceReport } : version);
      const updated = await updateWorkflowRun(run.id, {
        status: run.status === "error" ? "waiting" : run.status,
        stages: { ...(runningRun.stages || run.stages || {}), optimize: previousOptimizeStatus },
        resultPatch: {
          optimizationVersions: nextVersions,
          activeOptimizationVersionId: activeVersion.id,
          complianceReport,
          optimizationStatus: previousOptimizeStatus === "done" ? "done" : "pending",
          optimizationError: "",
          optimizePreviousStatus: "",
        },
      });
      if (updated?.run) onRunChange(normalizeWorkflowRun(updated.run));
      await onRefresh();
      const redCount = report.issues.filter((issue) => issue.level === "red").length;
      const yellowCount = report.issues.filter((issue) => issue.level === "yellow").length;
      setActionMessage(report.issues.length ? `检测完成：${redCount} 项红灯、${yellowCount} 项黄灯风险。` : "检测完成，未发现明显违规风险。");
      return true;
    } catch (error) {
      const message = error.message || "违规风险检测失败。";
      const updated = await updateWorkflowRun(run.id, {
        status: run.status === "error" ? "waiting" : run.status,
        stages: { ...(runningRun.stages || run.stages || {}), optimize: previousOptimizeStatus },
        resultPatch: { optimizationStatus: previousOptimizeStatus === "done" ? "done" : "pending", optimizationError: message, optimizePreviousStatus: "" },
      }).catch(() => null);
      if (updated?.run) onRunChange(normalizeWorkflowRun(updated.run));
      setActionMessage(message);
      return false;
    } finally {
      setCheckingCompliance(false);
    }
  }

  async function handleOptimizeScript(customPrompt, options = {}) {
    const instruction = String(customPrompt || "").trim();
    if (!summary.script || !instruction || optimizingScript || workflowRunHasLiveJob(run)) return false;
    const apiKeyId = options.llmKeyId || workflowForType?.llmKeyId || "";
    const model = options.modelId || workflowForType?.storyModelId || "";
    if (!apiKeyId || !model) {
      setActionMessage("请先在工作流配置里选择文案创意 LLM 渠道和第一步模型。");
      return false;
    }
    if (workflowHasOptimizationDownstream(run)) {
      const confirmed = await requestActionDialog({
        mode: "confirm",
        tone: "danger",
        title: "生成新的文案版本",
        summary: "新的优化版本会成为当前文案，并清空已生成的音频、分镜、图片和视频等下游结果。",
        target: title,
        hint: "所有历史文案版本都会保留；后续分镜将读取新版本的完整文案。",
        confirmText: "确认并生成",
      });
      if (!confirmed) return false;
    }
    setOptimizingScript(true);
    setActionMessage("正在根据自定义提示词优化文案...");
    let runningRun = run;
    try {
      const runningUpdate = await updateWorkflowRun(run.id, {
        status: "running",
        stages: { ...(run.stages || {}), optimize: "running" },
        resultPatch: { optimizationStatus: "running", optimizationError: "" },
      });
      runningRun = normalizeWorkflowRun(runningUpdate?.run || run);
      if (runningUpdate?.run) onRunChange(runningRun);
      const optimized = await requestWorkflowScriptOptimization({ ...workflowForType, llmKeyId: apiKeyId, storyModelId: model }, summary.script, instruction);
      const versions = workflowOptimizationVersions(run, summary.script);
      const sourceVersion = workflowActiveOptimizationVersion(run, versions, summary.script);
      const versionNumber = Math.max(0, ...versions.map((version) => Number(version.number) || 0)) + 1;
      const nextVersion = {
        id: createWorkflowLocalId("script-version"),
        number: versionNumber,
        content: optimized,
        prompt: instruction,
        sourceVersionId: sourceVersion.id,
        source: "custom-optimization",
        apiKeyId,
        modelId: model,
        createdAt: new Date().toISOString(),
        complianceReport: null,
      };
      const nextVersions = [...versions, nextVersion];
      const updated = await updateWorkflowRun(run.id, {
        status: run.status === "error" ? "waiting" : run.status,
        stages: workflowStagesAfterOptimization(run, talkingVideoWorkflow),
        result: workflowRunResultSnapshot(runningRun, workflowResetAfterScriptResult({
          scriptOutput: optimized,
          scriptError: "",
          optimizationVersions: nextVersions,
          activeOptimizationVersionId: nextVersion.id,
          complianceReport: {},
          optimizationStatus: "done",
          optimizationError: "",
        })),
        videoResultRemovals: Array.isArray(run.videoResults) ? run.videoResults : [],
        error: "",
      });
      if (updated?.run) onRunChange(normalizeWorkflowRun(updated.run));
      await onRefresh();
      setActionMessage(`V${versionNumber} 已生成并设为当前版本，后续分镜将使用此版本。`);
      return true;
    } catch (error) {
      const message = error.message || "文案优化失败。";
      const updated = await updateWorkflowRun(run.id, {
        status: run.status === "error" ? "waiting" : run.status,
        stages: { ...(runningRun.stages || run.stages || {}), optimize: "error" },
        resultPatch: { optimizationStatus: "error", optimizationError: message },
      }).catch(() => null);
      if (updated?.run) onRunChange(normalizeWorkflowRun(updated.run));
      setActionMessage(message);
      return false;
    } finally {
      setOptimizingScript(false);
    }
  }

  async function handleSaveOptimizationScript(nextScript) {
    const content = String(nextScript || "").trim();
    if (!content || content === summary.script || savingScript || optimizationBusy || workflowRunHasLiveJob(run)) return false;
    if (workflowHasOptimizationDownstream(run)) {
      const confirmed = await requestActionDialog({
        mode: "confirm",
        tone: "danger",
        title: "保存为新的文案版本",
        summary: "手动修改后的文案会成为当前版本，并清空已生成的音频、分镜、图片和视频等下游结果。",
        target: title,
        hint: "修改前的版本会完整保留；后续分镜将读取新版本文案。",
        confirmText: "确认保存",
      });
      if (!confirmed) return false;
    }
    setSavingScript(true);
    setActionMessage("正在保存新的文案版本...");
    try {
      const versions = workflowOptimizationVersions(run, summary.script);
      const sourceVersion = workflowActiveOptimizationVersion(run, versions, summary.script);
      const versionNumber = Math.max(0, ...versions.map((version) => Number(version.number) || 0)) + 1;
      const nextVersion = {
        id: createWorkflowLocalId("script-version"),
        number: versionNumber,
        content,
        prompt: "手动修改当前文案",
        sourceVersionId: sourceVersion.id,
        source: "manual-edit",
        createdAt: new Date().toISOString(),
        complianceReport: null,
      };
      const updated = await updateWorkflowRun(run.id, {
        status: run.status === "error" ? "waiting" : run.status,
        stages: workflowStagesAfterOptimization(run, talkingVideoWorkflow),
        result: workflowRunResultSnapshot(run, workflowResetAfterScriptResult({
          scriptOutput: content,
          scriptError: "",
          optimizationVersions: [...versions, nextVersion],
          activeOptimizationVersionId: nextVersion.id,
          complianceReport: {},
          optimizationStatus: "done",
          optimizationError: "",
        })),
        videoResultRemovals: Array.isArray(run.videoResults) ? run.videoResults : [],
        error: "",
      });
      if (updated?.run) onRunChange(normalizeWorkflowRun(updated.run));
      await onRefresh();
      setActionMessage(`手动修改已保存为 V${versionNumber}，后续分镜将使用此版本。`);
      return true;
    } catch (error) {
      setActionMessage(error.message || "文案版本保存失败。");
      return false;
    } finally {
      setSavingScript(false);
    }
  }

  async function handleActivateOptimizationVersion(version) {
    const content = String(version?.content || "").trim();
    if (!content || content === summary.script || workflowRunHasLiveJob(run)) return false;
    const hasDownstream = workflowHasOptimizationDownstream(run);
    const confirmed = await requestActionDialog({
      mode: "confirm",
      tone: "danger",
      title: `将 V${version.number} 设为当前版本`,
      summary: hasDownstream
        ? "设为当前后，将清空已生成的音频、分镜、图片和视频等下游结果。"
        : "设为当前后，工作流后续节点将读取这个版本的完整文案。",
      target: title,
      hint: hasDownstream
        ? "历史文案版本仍会完整保留；此操作不会删除版本历史。"
        : "历史文案版本仍会完整保留，之后仍可切换回来。",
      confirmText: "确认设为当前",
    });
    if (!confirmed) return false;
    setOptimizingScript(true);
    try {
      const versions = workflowOptimizationVersions(run, summary.script);
      const updated = await updateWorkflowRun(run.id, {
        status: run.status === "error" ? "waiting" : run.status,
        stages: workflowStagesAfterOptimization(run, talkingVideoWorkflow),
        result: workflowRunResultSnapshot(run, workflowResetAfterScriptResult({
          scriptOutput: content,
          scriptError: "",
          optimizationVersions: versions,
          activeOptimizationVersionId: version.id,
          complianceReport: version.complianceReport || {},
          optimizationStatus: Number(version.number) > 1 ? "done" : "pending",
          optimizationError: "",
        })),
        videoResultRemovals: Array.isArray(run.videoResults) ? run.videoResults : [],
        error: "",
      });
      if (updated?.run) onRunChange(normalizeWorkflowRun(updated.run));
      await onRefresh();
      setActionMessage(`已切换到 V${version.number}，后续分镜将使用此版本。`);
      return true;
    } catch (error) {
      setActionMessage(error.message || "切换文案版本失败。");
      return false;
    } finally {
      setOptimizingScript(false);
    }
  }

  async function handleQueueAudio(options = {}) {
    const finalScript = stringFromWorkflowValue(options.script || workflowFinalScriptText(summary)).trim();
    if (!finalScript || queueingAudio || audioRunning) return;
    const variant = options.scriptVariant || "voice";
    const existingTrack = summary.audioTracks.find((track) => track.variant === variant && track.source !== "upload");
    if (existingTrack) {
      const confirmed = await requestActionDialog({
        mode: "confirm",
        tone: "danger",
        title: "重新生成音频",
        summary: "再次生成会替换这条音频、时间戳和 SRT。",
        target: workflowAudioTrackLabel(variant),
        confirmText: "确认替换",
      });
      if (!confirmed) return;
    }
    const defaultAudioKey = audioKeys.find((key) => key.id === (workflow?.audioKeyId || "")) || audioKeys[0] || null;
    const audioModels = workflowAudioModelOptions(defaultAudioKey);
    const audioModelId = options.audioModelId || workflow?.audioModelId || audioModels[0]?.id || "";
    if (!defaultAudioKey?.id && !options.audioUrl) {
      setActionMessage("请先在工作流配置中选择音频生成渠道，或在音频页上传已有音频。");
      setActiveTab("audio");
      return;
    }
    setQueueingAudio(true);
    setActionMessage("正在生成口播音频...");
    setActiveTab("audio");
    let completedAudioChunks = 0;
    let totalAudioChunks = 0;
    const audioStartedAt = new Date().toISOString();
    try {
      const audioSettings = resolveWorkflowAudioGenerationSettings(workflow, {
        audioVoice: options.voice,
        audioVoicePresetId: options.voicePresetId,
        audioReferenceId: options.referenceId,
        audioReferences: options.references,
      });
      const shotReferenceSegments = workflowAudioShotTextsForScript(run, finalScript);
      const chunks = splitWorkflowAudioText(finalScript, workflowAudioChunkLimit(), {
        referenceSegments: shotReferenceSegments,
      });
      totalAudioChunks = chunks.length;
      const runningUpdate = await updateWorkflowRun(run.id, {
        status: "running",
        completedAt: "",
        stages: {
          ...(run.stages || {}),
          optimize: talkingVideoWorkflow ? "skipped" : workflowOptimizeStageForAudio(run, summary),
          audio: "running",
        },
        result: workflowRunResultSnapshot(run, {
          audioStatus: "running",
          audioError: "",
          audioProgress: {
            status: "running",
            completedChunks: 0,
            totalChunks: totalAudioChunks,
            currentChunk: totalAudioChunks ? 1 : 0,
            startedAt: audioStartedAt,
            updatedAt: audioStartedAt,
          },
        }),
        error: "",
      });
      if (runningUpdate?.run) onRunChange(normalizeWorkflowRun(runningUpdate.run));
      setActionMessage(chunks.length > 1 ? `文案较长，已拆成 ${chunks.length} 段，正在生成第 1 段...` : "正在生成口播音频...");
      const parts = [];
      for (const [index, chunk] of chunks.entries()) {
        if (chunks.length > 1) setActionMessage(`文案较长，正在生成第 ${index + 1}/${chunks.length} 段...`);
        const audioResult = await generateAudio({
          apiKeyId: options.audioKeyId || defaultAudioKey?.id || workflow?.audioKeyId || "",
          text: chunk.text,
          prompt: chunk.text,
          modelId: audioModelId,
          model: audioModelId,
          format: options.format || workflow?.audioFormat || "mp3",
          emotion: options.emotion || workflow?.audioEmotion || "natural",
          bitrate: options.bitrate || workflow?.audioBitrate || 128,
          speed: options.speed || workflow?.audioSpeed || 1,
          voice: audioSettings.audioVoice,
          voicePresetId: audioSettings.audioVoicePresetId,
          referenceId: audioSettings.audioReferenceId,
          references: audioSettings.audioReferences,
          projectName: `${run.topic || workflow?.name || "workflow-audio"}-${variant}-${String(index + 1).padStart(2, "0")}`,
          taskType: "workflow-audio",
        });
        const generatedPart = buildWorkflowAudioFromGeneratedResult(audioResult, chunk.text);
        if (!generatedPart.audio_url) throw new Error(`第 ${index + 1} 段音频已生成，但没有返回可播放音频 URL。`);
        if (chunks.length > 1) setActionMessage(`第 ${index + 1}/${chunks.length} 段音频已生成，正在对齐真实时间戳...`);
        let transcription = null;
        try {
          transcription = await transcribeAudio({
            apiKeyId: options.audioKeyId || defaultAudioKey?.id || workflow?.audioKeyId || "",
            audioUrl: generatedPart.audio_url,
            fileName: `workflow-audio-${variant}-${index + 1}.${options.format || workflow?.audioFormat || "mp3"}`,
            language: workflowAudioLanguageForVariant(variant, workflow),
            taskType: "workflow-audio-asr",
          });
        } catch (error) {
          throw new Error(`第 ${index + 1} 段音频已生成，但时间戳对齐失败：${error.message || "音频服务 ASR 请求失败"}`);
        }
        const referenceSegments = Array.isArray(chunk.referenceSegments) && chunk.referenceSegments.length
          ? chunk.referenceSegments
          : workflowAudioReferenceSegmentsForChunk(run, finalScript, chunk.text);
        const part = buildWorkflowAudioFromTranscription({
          audioUrl: generatedPart.audio_url,
          provider: transcription.provider,
          model: transcription.model,
          referenceSegments,
          preserveRawTiming: talkingVideoWorkflow,
          source: "generated-asr",
        }, transcription, chunk.text);
        parts.push({
          ...part,
          index: index + 1,
          name: chunk.name || (chunks.length > 1 ? `第 ${index + 1} 段` : workflowAudioTrackLabel(variant)),
          text: chunk.text,
          ...(talkingVideoWorkflow ? { rawSegments: part.rawSegments } : {}),
          segments: part.segments,
          ...(talkingVideoWorkflow ? { subtitleStatus: part.subtitleStatus } : {}),
        });
        completedAudioChunks = index + 1;
        const progressUpdatedAt = new Date().toISOString();
        const progressUpdate = await updateWorkflowRun(run.id, {
          resultPatch: {
            audioProgress: {
              status: "running",
              completedChunks: completedAudioChunks,
              totalChunks: totalAudioChunks,
              currentChunk: Math.min(completedAudioChunks + 1, totalAudioChunks),
              startedAt: audioStartedAt,
              updatedAt: progressUpdatedAt,
            },
          },
        });
        const progressRun = progressUpdate?.run ? normalizeWorkflowRun(progressUpdate.run) : null;
        if (progressRun && (
          progressRun.stages?.audio !== "running"
          || progressRun.result?.audioStatus !== "running"
        )) {
          throw new Error(progressRun.result?.audioError || progressRun.error || "音频任务已经结束，请重试。");
        }
        if (progressRun) onRunChange(progressRun);
      }
      const audio = buildWorkflowAudioTrack({
        variant,
        source: "generated-asr",
        script: finalScript,
        parts,
        replaceId: existingTrack?.id || "",
        subtitleStatus: talkingVideoWorkflow ? "pending" : "final",
      });
      const audioTracks = upsertWorkflowAudioTrack(summary.audioTracks, audio, { replaceVariant: variant });
      const timeline = workflowTimelineFromAudio(run, audio);
      const subtitleWarning = workflowAudioTrackSubtitleCountWarning(audio, run, summary);
      const updated = await updateWorkflowRun(run.id, {
        status: "waiting",
        completedAt: "",
        stages: {
          ...(run.stages || {}),
          optimize: talkingVideoWorkflow ? "skipped" : workflowOptimizeStageForAudio(run, summary),
          audio: "done",
          shot: run.stages?.shot || "pending",
          image: run.stages?.image || "pending",
          videoPrompt: run.stages?.videoPrompt || "pending",
          video: run.stages?.video || "pending",
          draft: run.stages?.draft || "pending",
        },
        result: workflowRunResultSnapshot(run, {
          audio,
          audioTracks,
          audioUrl: audio.audio_url,
          audioDuration: audio.duration,
          ...(talkingVideoWorkflow ? { audioRawSegments: audio.rawSegments } : {}),
          audioSegments: talkingVideoWorkflow ? [] : audio.segments,
          subtitleSrt: audio.subtitle_srt,
          timeline,
          ...(talkingVideoWorkflow ? {
            talkingShotSourceAudioSegments: [],
            talkingShotSourceSubtitleSrt: "",
            talkingShotSegmentationMode: "",
            talkingShotSegmentationPlan: [],
          } : {}),
          audioStatus: "done",
          audioError: "",
          audioProgress: {
            status: "done",
            completedChunks: totalAudioChunks,
            totalChunks: totalAudioChunks,
            currentChunk: totalAudioChunks,
            startedAt: audioStartedAt,
            updatedAt: new Date().toISOString(),
          },
          draft: {},
          draftStatus: "",
          draftUrl: "",
          draftError: "",
        }),
        error: "",
      });
      if (updated?.run) onRunChange(normalizeWorkflowRun(updated.run));
      await onRefresh();
      setActionMessage(subtitleWarning || (talkingVideoWorkflow
        ? `${workflowAudioTrackLabel(variant)}已生成，ASR 原始时间轴已保存；最终 SRT 将在分镜切分后生成。`
        : `${workflowAudioTrackLabel(variant)}已生成，时间戳和 SRT 已同步保存。`));
    } catch (error) {
      const message = error.message || "音频生成失败。";
      await updateWorkflowRun(run.id, {
        status: "error",
        stages: {
          ...(run.stages || {}),
          optimize: talkingVideoWorkflow ? "skipped" : workflowOptimizeStageForAudio(run, summary),
          audio: "error",
        },
        result: workflowRunResultSnapshot(run, {
          audioStatus: "error",
          audioError: message,
          audioProgress: {
            status: "error",
            completedChunks: completedAudioChunks,
            totalChunks: totalAudioChunks,
            currentChunk: Math.min(completedAudioChunks + 1, totalAudioChunks),
            startedAt: audioStartedAt,
            updatedAt: new Date().toISOString(),
            message,
          },
        }),
        error: message,
      }).catch(() => null);
      await onRefresh().catch(() => null);
      setActionMessage(message);
    } finally {
      setQueueingAudio(false);
    }
  }

  async function handleQueueAudioVariants(variants = [], options = {}) {
    const scripts = workflowAudioScriptChoices(summary, workflow);
    const selected = scripts.filter((item) => variants.includes(item.variant) && item.available);
    if (!selected.length) {
      setActionMessage("请至少选择一个可生成音频的文案版本。");
      setActiveTab("audio");
      return;
    }
    for (const choice of selected) {
      await handleQueueAudio({
        script: choice.script,
        scriptVariant: choice.variant,
        audioKeyId: options.audioKeyId,
        audioModelId: options.audioModelId,
        format: options.audioFormat,
        emotion: options.audioEmotion,
        bitrate: options.audioBitrate,
        speed: options.audioSpeed,
        voice: options.audioVoice,
        voicePresetId: options.audioVoicePresetId,
        referenceId: options.audioReferenceId,
        references: options.audioReferences,
      });
    }
  }

  async function handleSaveAudio(audioPatch) {
    const finalScript = stringFromWorkflowValue(audioPatch.script || workflowFinalScriptText(summary)).trim();
    const audioUrl = String(audioPatch.audioUrl || "").trim();
    if (!audioUrl || savingAudio) return;
    setSavingAudio(true);
    setActionMessage(audioPatch.audioDataUrl ? "正在解析上传音频..." : "正在保存音频时间轴...");
    try {
      const defaultAudioKey = audioKeys.find((key) => key.id === (workflow?.audioKeyId || "")) || audioKeys[0] || null;
      let transcription = null;
      if (audioPatch.audioDataUrl) {
        if (!defaultAudioKey?.id && !audioPatch.audioKeyId) {
          throw new Error("请先在 API 设置里添加 音频服务 音频 API Key，再上传解析音频。");
        }
        transcription = await transcribeAudio({
          apiKeyId: audioPatch.audioKeyId || defaultAudioKey?.id || workflow?.audioKeyId || "",
          audioDataUrl: audioPatch.audioDataUrl,
          fileName: audioPatch.name || "upload-audio",
          language: audioPatch.language || workflow?.language || "",
          taskType: "workflow-audio-asr",
        });
      }
      const referenceSegments = workflowAudioReferenceSegmentsForScript(run, finalScript);
      const manualAudio = transcription
        ? buildWorkflowAudioFromTranscription({
            ...audioPatch,
            provider: transcription.provider,
            model: transcription.model,
            referenceSegments,
            preserveRawTiming: talkingVideoWorkflow,
          }, transcription, finalScript)
        : buildWorkflowAudioFromManualInput(audioPatch, finalScript);
      const rawTrack = buildWorkflowAudioTrack({
        variant: "upload",
        source: "upload",
        script: finalScript || transcription?.text || "",
        parts: [{ ...manualAudio, index: 1, name: audioPatch.name || "上传音频" }],
        subtitleStatus: talkingVideoWorkflow ? "pending" : "final",
      });
      const audio = transcription || talkingVideoWorkflow ? rawTrack : alignWorkflowAudioTrackToShots(run, rawTrack, finalScript);
      const alignmentWarning = workflowAudioAlignmentWarning(audio);
      const audioTracks = upsertWorkflowAudioTrack(summary.audioTracks, audio);
      const timeline = workflowTimelineFromAudio(run, audio);
      const updated = await updateWorkflowRun(run.id, {
        status: run.status === "error" ? "waiting" : run.status,
        stages: {
          ...(run.stages || {}),
          audio: "done",
          draft: "pending",
        },
        result: workflowRunResultSnapshot(run, {
          audio,
          audioTracks,
          audioUrl: audio.audio_url,
          audioDuration: audio.duration,
          ...(talkingVideoWorkflow ? { audioRawSegments: audio.rawSegments } : {}),
          audioSegments: talkingVideoWorkflow ? [] : audio.segments,
          subtitleSrt: audio.subtitle_srt,
          timeline,
          ...(talkingVideoWorkflow ? {
            talkingShotSourceAudioSegments: [],
            talkingShotSourceSubtitleSrt: "",
            talkingShotSegmentationMode: "",
            talkingShotSegmentationPlan: [],
          } : {}),
          audioStatus: "done",
          audioError: "",
          draft: {},
          draftStatus: "",
          draftUrl: "",
          draftError: "",
        }),
        error: "",
      });
      if (updated?.run) onRunChange(normalizeWorkflowRun(updated.run));
      await onRefresh();
      setActionMessage(alignmentWarning || (talkingVideoWorkflow
        ? "音频已解析，ASR 原始时间轴已保存；最终 SRT 将在分镜切分后生成。"
        : transcription ? "上传音频已解析，时间戳和 SRT 已保存。" : "音频已保存，时间戳和 SRT 已更新。"));
    } catch (error) {
      setActionMessage(friendlyWorkflowAudioUploadError(error));
      throw error;
    } finally {
      setSavingAudio(false);
    }
  }

  async function handleDeleteAudio(trackId) {
    const target = summary.audioTracks.find((track) => track.id === trackId);
    if (!target || savingAudio || queueingAudio) return;
    const confirmed = await requestActionDialog({
      mode: "confirm",
      tone: "danger",
      title: "删除音频",
      summary: "删除后会同步移除这条音频的时间戳和 SRT，剪辑草稿会回到待生成状态。",
      target: target.label || "这条音频",
      confirmText: "确认删除",
    });
    if (!confirmed) return;
    setSavingAudio(true);
    setActionMessage("正在删除音频...");
    try {
      const audioTracks = summary.audioTracks.filter((track) => track.id !== trackId);
      const activeAudio = audioTracks.at(-1) || {};
      const timeline = activeAudio.audio_url ? workflowTimelineFromAudio(run, activeAudio) : {};
      const updated = await updateWorkflowRun(run.id, {
        status: run.status === "error" && audioTracks.length ? "waiting" : run.status,
        stages: {
          ...(run.stages || {}),
          audio: audioTracks.length ? "done" : "pending",
          draft: "pending",
        },
        result: workflowRunResultSnapshot(run, {
          audio: activeAudio.audio_url ? activeAudio : {},
          audioTracks,
          audioUrl: activeAudio.audio_url || "",
          audioDuration: Number(activeAudio.duration || 0),
          ...(talkingVideoWorkflow ? { audioRawSegments: Array.isArray(activeAudio.rawSegments) ? activeAudio.rawSegments : [] } : {}),
          audioSegments: Array.isArray(activeAudio.segments) ? activeAudio.segments : [],
          subtitleSrt: activeAudio.subtitle_srt || "",
          timeline,
          ...(talkingVideoWorkflow ? {
            talkingShotSourceAudioSegments: [],
            talkingShotSourceSubtitleSrt: "",
            talkingShotSegmentationMode: "",
            talkingShotSegmentationPlan: [],
          } : {}),
          audioStatus: audioTracks.length ? "done" : "",
          audioError: "",
          draft: {},
          draftStatus: "",
          draftUrl: "",
          draftError: "",
        }),
        error: "",
      });
      if (updated?.run) onRunChange(normalizeWorkflowRun(updated.run));
      await onRefresh();
      setActionMessage("音频已删除。");
    } catch (error) {
      setActionMessage(error.message || "音频删除失败。");
    } finally {
      setSavingAudio(false);
    }
  }

  async function handleUpdateAudioSrt(trackId, srtText) {
    const target = summary.audioTracks.find((track) => track.id === trackId);
    if (!target || savingAudio || queueingAudio) return;
    const segments = parseWorkflowSrtSegments(srtText);
    if (!segments.length) throw new Error("没有解析到有效 SRT 字幕，请检查时间码格式。");
    const expectedCount = workflowAudioExpectedSubtitleCount(run, summary);
    if (expectedCount && segments.length !== expectedCount) {
      throw new Error(`当前 SRT 是 ${segments.length} 条，分镜图片是 ${expectedCount} 张。请调整到一致后再保存。`);
    }
    setSavingAudio(true);
    setActionMessage("正在保存 SRT...");
    try {
      const normalizedSrt = workflowSegmentsToSrt(segments);
      const updatedTrack = {
        ...target,
        segments,
        subtitle_srt: normalizedSrt,
        subtitleStatus: "final",
        duration: Math.max(Number(target.duration || 0), Number(segments.at(-1)?.end || 0)),
        updatedAt: new Date().toISOString(),
      };
      const audioTracks = summary.audioTracks.map((track) => (track.id === trackId ? updatedTrack : track));
      const activeAudio = audioTracks.at(-1) || updatedTrack;
      const timeline = workflowTimelineFromAudio(run, activeAudio);
      const updated = await updateWorkflowRun(run.id, {
        status: run.status === "error" ? "waiting" : run.status,
        stages: {
          ...(run.stages || {}),
          audio: "done",
          draft: "pending",
        },
        result: workflowRunResultSnapshot(run, {
          audio: activeAudio,
          audioTracks,
          audioUrl: activeAudio.audio_url || "",
          audioDuration: Number(activeAudio.duration || 0),
          ...(talkingVideoWorkflow ? { audioRawSegments: Array.isArray(activeAudio.rawSegments) ? activeAudio.rawSegments : [] } : {}),
          audioSegments: Array.isArray(activeAudio.segments) ? activeAudio.segments : [],
          subtitleSrt: activeAudio.subtitle_srt || "",
          timeline,
          ...(talkingVideoWorkflow ? {
            talkingShotSourceAudioSegments: [],
            talkingShotSourceSubtitleSrt: "",
            talkingShotSegmentationPlan: [],
          } : {}),
          audioStatus: "done",
          audioError: "",
          draft: {},
          draftStatus: "",
          draftUrl: "",
          draftError: "",
        }),
        error: "",
      });
      if (updated?.run) onRunChange(normalizeWorkflowRun(updated.run));
      await onRefresh();
      setActionMessage("SRT 已保存，剪辑草稿需要重新生成。");
    } finally {
      setSavingAudio(false);
    }
  }

  async function handleQueueDraft(options = {}) {
    const audioChoices = workflowDraftAudioChoices(summary, musicAssets);
    const selectedAudio = audioChoices.find((choice) => choice.id === options.audioTrackId && !choice.disabled)
      || audioChoices.find((choice) => !choice.disabled);
    if (!selectedAudio || queueingDraft || draftRunning) {
      const errorMessage = "请先完成音频节点，确保有音频 URL 和最终 SRT 时间轴。";
      setActionMessage(errorMessage);
      setDraftDialog((current) => current ? { ...current, localError: errorMessage } : current);
      return false;
    }
    const defaultDraftKey = draftKeys[0] || null;
    const draftKeyId = String(options.draftKeyId || defaultDraftKey?.id || "").trim();
    if (!draftKeyId) {
      const errorMessage = "请先选择剪辑草稿 API。可在 API 设置里添加 管理员已启用的草稿服务 Key。";
      setActionMessage(errorMessage);
      setDraftDialog((current) => current ? { ...current, localError: errorMessage } : current);
      return false;
    }
    const materialChoices = workflowDraftMaterialChoices(summary);
    const selectedMaterial = materialChoices.find((choice) => choice.id === options.materialSource && !choice.disabled)
      || materialChoices.find((choice) => !choice.disabled);
    if (!selectedMaterial) {
      const errorMessage = "请先生成分镜图片或视频结果，再生成剪辑草稿。";
      setActionMessage(errorMessage);
      setDraftDialog((current) => current ? { ...current, localError: errorMessage } : current);
      return false;
    }
    const ratioChoices = workflowDraftRatioChoices();
    const selectedRatio = ratioChoices.find((choice) => choice.id === options.aspectRatio)
      || ratioChoices[0];
    const motionChoices = workflowDraftImageMotionChoices();
    const selectedMotion = selectedMaterial.id === "video"
      ? motionChoices.find((choice) => choice.id === "none") || motionChoices[0]
      : motionChoices.find((choice) => choice.id === options.imageMotion)
        || motionChoices.find((choice) => choice.id === "zoom_in")
        || motionChoices[0];
    const motionScaleChoices = workflowDraftImageMotionScaleChoices();
    const selectedMotionScale = motionScaleChoices.find((choice) => choice.id === String(options.imageMotionScale || ""))
      || motionScaleChoices.find((choice) => choice.id === "1.06")
      || motionScaleChoices[0];
    const watermarkEnabled = Boolean(options.watermarkEnabled);
    const watermarkText = String(options.watermarkText || "").trim();
    if (watermarkEnabled && !watermarkText) {
      const errorMessage = "请手动填写水印内容。";
      setActionMessage(errorMessage);
      setDraftDialog((current) => current ? { ...current, localError: errorMessage } : current);
      return false;
    }
    setQueueingDraft(true);
    setActionMessage("正在生成剪辑草稿...");
    setDraftDialog((current) => current ? { ...current, localError: "" } : current);
    try {
      await queueWorkflowNode(run.id, "draft", {
        workflowId: run.workflowId,
        title: "剪辑草稿生成",
        payload: {
          source: "manual-draft",
          draftKeyId,
          audioTrackId: selectedAudio.timingTrackId || selectedAudio.id,
          audioSourceId: selectedAudio.id,
          audioSource: selectedAudio.source || "generated",
          audioLabel: selectedAudio.label || "",
          audioUrl: selectedAudio.source === "music" ? selectedAudio.audioUrl : "",
          audioDuration: selectedAudio.source === "music" ? Number(selectedAudio.duration || 0) : 0,
          materialSource: selectedMaterial.id,
          aspectRatio: selectedRatio.id,
          imageMotion: selectedMotion.id,
          imageMotionScale: selectedMotionScale.id,
          watermarkEnabled,
          watermarkText,
          watermarkMode: ["fixed", "motion"].includes(options.watermarkMode) ? options.watermarkMode : "corners",
          watermarkPosition: options.watermarkPosition || "bottom-right",
          watermarkSize: options.watermarkSize || "medium",
          watermarkColor: options.watermarkColor || "#ffffff",
          watermarkOpacity: Number(options.watermarkOpacity || 70),
        },
      });
      await onRefresh();
      setActionMessage("剪辑草稿已进入后台生成，可以关闭弹窗。完成后可在弹窗中打开草稿。");
      setDraftDialog((current) => current ? { ...current, localError: "" } : current);
      return false;
    } catch (error) {
      await onRefresh().catch(() => {});
      const errorMessage = error.message || "剪辑草稿生成失败。";
      setActionMessage(errorMessage);
      setDraftDialog((current) => current ? { ...current, localError: errorMessage } : current);
      return false;
    } finally {
      setQueueingDraft(false);
    }
  }

  async function handleQueueShot(options = {}) {
    const autoImages = Boolean(options.autoImages);
    const storyboardMode = isStoryboardWorkflow(workflowForType) && options.storyboardMode === "ai-director"
      ? "ai-director"
      : "traditional";
    const roleOutfitVariantDetection = allowRoleOutfitVariantDetection && Boolean(options.roleOutfitVariantDetection);
    if (!summary.script || queueingShot || shotRunning) return;
    const selectedImageRatio = options.ratio || workflow?.ratio || "";
    const selectedImageSize = Object.prototype.hasOwnProperty.call(options, "imageSize")
      ? options.imageSize
      : workflow?.imageSize || workflowImageRequestSize(selectedImageRatio);
    setQueueingShot(true);
    setActionMessage(autoImages ? "正在提交分镜和图片生成任务..." : "正在提交分镜生成任务...");
    setActiveTab("shot");
    try {
      const queueResult = await queueWorkflowNode(run.id, "shot", {
        workflowId: run.workflowId,
        title: autoImages ? "分镜和图片生成" : "分镜生成",
        payload: {
          autoImages,
          storyboardMode,
          ...(storyboardMode === "ai-director" ? {
            maxDurationSeconds: Number(options.maxDurationSeconds) === 10 ? 10 : 15,
          } : {}),
          ...(talkingVideoWorkflow ? {
            talkingShotSegmentationMode: options.talkingShotSegmentationMode === "punctuation"
              ? "punctuation"
              : "duration-semantic",
          } : {}),
          llmKeyId: options.llmKeyId || workflow?.llmKeyId || "",
          shotModelId: options.shotModelId || options.modelId || workflow?.shotModelId || workflow?.storyModelId || "",
          modelId: options.modelId || options.shotModelId || workflow?.shotModelId || workflow?.storyModelId || "",
          roleOutfitVariantDetection,
          ...(roleOutfitVariantDetection ? {
            outfitDetectionLlmKeyId: options.outfitDetectionLlmKeyId || options.llmKeyId || workflow?.llmKeyId || "",
            outfitDetectionModelId: options.outfitDetectionModelId || options.shotModelId || options.modelId || workflow?.shotModelId || workflow?.storyModelId || "",
            outfitImageKeyId: options.outfitImageKeyId || options.imageKeyId || workflow?.imageKeyId || "",
            outfitImageModelId: options.outfitImageModelId || options.imageModelId || workflow?.imageModelId || "",
            outfitImageResolution: options.outfitImageResolution || options.imageResolution || workflow?.imageResolution || "",
            outfitImageRatio: options.outfitImageRatio || "1:1",
            outfitImageSize: options.outfitImageSize || workflowImageRequestSize(options.outfitImageRatio || "1:1"),
            outfitImageCustomSize: options.outfitImageCustomSize || "",
          } : {}),
          ...visualStylePayload,
          promptMode: "create-compatible",
          ...(autoImages ? {
            imageKeyId: options.imageKeyId || workflow?.imageKeyId || "",
            imageModelId: options.imageModelId || workflow?.imageModelId || "",
            imageResolution: options.imageResolution || workflow?.imageResolution || "",
            ratio: selectedImageRatio,
            imageSize: selectedImageSize || workflowImageRequestSize(selectedImageRatio),
            customSize: options.customSize || workflow?.customSize || "",
          } : {}),
        },
      });
      const backendJobs = objectFromWorkflowValue(run.backendJobs);
      const resultPayload = workflowRunResultSnapshot(run, workflowResetAfterShotResult({
        shotOutput: "",
        shotError: "",
        shots: [],
        storyboardMode,
        aiDirectorPlan: {},
        aiDirectorMaxDurationSeconds: storyboardMode === "ai-director"
          ? Number(options.maxDurationSeconds) === 10 ? 10 : 15
          : 0,
        backendJobs: {
          ...backendJobs,
          shot: queueResult?.job || backendJobs.shot,
        },
      }, { preserveAudio: talkingVideoWorkflow }));
      const updated = await updateWorkflowRun(run.id, {
        status: "running",
        completedAt: "",
        stages: {
          ...(run.stages || {}),
          topic: run.kind === "topic-child" ? "skipped" : run.stages?.topic || "done",
          outline: "skipped",
          script: "done",
          shot: "running",
          image: autoImages ? "running" : "pending",
          audio: talkingVideoWorkflow ? run.stages?.audio || "done" : "pending",
          videoPrompt: "pending",
          video: "pending",
          draft: "pending",
        },
        result: resultPayload,
        error: "",
      });
      if (updated?.run) onRunChange(normalizeWorkflowRun(updated.run));
      await onRefresh();
      setActionMessage(autoImages ? "分镜生成已进入队列，完成后会继续生成图片。" : "分镜生成已进入队列。");
    } catch (error) {
      setActionMessage(error.message || "分镜任务提交失败。");
    } finally {
      setQueueingShot(false);
    }
  }

  function openMissingImageDialog() {
    if (!canQueueImages) return;
    const missingCount = missingImageShots.length;
    if (!missingCount) {
      setActionMessage("图片已全部生成，暂无缺失图片。");
      return;
    }
    setActiveTab("image");
    const unknownResultCount = missingImageShots.filter((shot) => Boolean(shot.imageResultUnknown)).length;
    const includesRoleAssets = missingImageShots.some((shot) => shot.assetType === "role");
    setImageRetryDialog({
      mode: "missing",
      title: "生成缺失图片",
      summary: `当前缺失 ${missingCount} 张分镜图片，可在生成前临时切换图片渠道和模型。`,
      hint: unknownResultCount
        ? `其中 ${unknownResultCount} 张上次请求结果未知，渠道可能已计费；确认后会重新生成这些缺失图片。`
        : workflowHasImageDownstream(run, workflowForType)
        ? talkingVideoWorkflow
          ? "确认后会生成缺失图片并重置后续视频提示和制作状态；已生成音频、视频任务和视频结果会保留。"
          : "确认后会生成缺失图片并重置后续音频、视频提示和制作状态；已有视频任务和视频结果会保留。"
        : "确认后会仅生成缺失的分镜图片，已生成图片会保留。",
      shotIds: missingImageShots.map(workflowShotId).filter(Boolean),
      forceRegenerate: false,
      imageKeyId: workflow?.imageKeyId || "",
      imageModelId: workflow?.imageModelId || "",
      ...visualStylePayload,
      imageResolution: workflow?.imageResolution || "",
      ratio: workflow?.ratio || "",
      imageSize: workflow?.imageSize || workflowImageRequestSize(workflow?.ratio),
      customSize: workflow?.customSize || "",
      includesRoleAssets,
      roleImageStyleId: normalizeWorkflowRoleImageStyleId(workflow?.roleImageStyleId || defaultWorkflowRoleImageStyleId),
      roleImageCustomStylePrompt: workflow?.roleImageCustomStylePrompt || "",
    });
  }

  function openRegenerateImageDialog(shot) {
    const shotId = workflowShotId(shot);
    if (!shotId || workflowRunHasLiveJob(run)) {
      setActionMessage("当前工作流节点正在运行，暂时不能重生分镜图片。");
      return;
    }
    setImageRetryDialog({
      mode: "single",
      title: "重生图片",
      summary: `将重新生成镜头 ${workflowShotNumber(shot, 0)} 的分镜图片，可在生成前临时切换图片渠道和模型。`,
      hint: workflowHasImageDownstream(run, workflowForType)
        ? talkingVideoWorkflow
          ? "确认后会替换当前图片并重置后续视频提示和制作状态；已生成音频、视频任务和视频结果会保留。"
          : "确认后会替换当前图片并重置后续音频、视频提示和制作状态；已有视频任务和视频结果会保留。"
        : "确认后会替换当前图片，其他已生成图片会保留。",
      shotIds: [shotId],
      forceRegenerate: true,
      imageKeyId: workflow?.imageKeyId || "",
      imageModelId: workflow?.imageModelId || "",
      ...visualStylePayload,
      imageResolution: workflow?.imageResolution || "",
      ratio: workflow?.ratio || "",
      imageSize: workflow?.imageSize || workflowImageRequestSize(workflow?.ratio),
      customSize: workflow?.customSize || "",
      includesRoleAssets: shot.assetType === "role",
      roleImageStyleId: normalizeWorkflowRoleImageStyleId(workflow?.roleImageStyleId || defaultWorkflowRoleImageStyleId),
      roleImageCustomStylePrompt: workflow?.roleImageCustomStylePrompt || "",
    });
  }

  function openManualOutfitDialog(baseRole = null) {
    if (!ecommerceWorkflow || workflowRunHasLiveJob(run)) {
      setActionMessage("当前工作流节点正在运行，暂时不能添加变装版本。");
      return;
    }
    const roleOptions = workflowManualOutfitRoleOptions(run, summary);
    if (!roleOptions.length) {
      setActionMessage("当前没有可作为基础的角色资产。");
      return;
    }
    const baseRef = workflowShotAssetRef(baseRole || {}, 0);
    const selectedRole = roleOptions.find((role) => normalizeWorkflowAssetMatchText(role.assetRef) === normalizeWorkflowAssetMatchText(baseRef)) || roleOptions[0];
    const defaultApi = llmKeys.find((key) => key.id === (workflow?.llmKeyId || "")) || llmKeys[0] || null;
    const models = workflowLlmModelOptions(defaultApi);
    const defaultModel = models.some((model) => model.id === (workflow?.shotModelId || workflow?.storyModelId)) ? (workflow.shotModelId || workflow.storyModelId) : models[0]?.id || "";
    setManualOutfitDialog({
      roleAssetRef: selectedRole.assetRef,
      variantName: "",
      outfitPrompt: "",
      shotRefs: [],
      matchMode: "manual",
      autoMatchLlmKeyId: defaultApi?.id || "",
      autoMatchModelId: defaultModel,
    });
  }

  async function handleAutoMatchManualOutfitShots(dialog = {}) {
    if (matchingManualOutfit || savingManualOutfit) return;
    const roleOptions = workflowManualOutfitRoleOptions(run, summary);
    const baseRole = roleOptions.find((role) => normalizeWorkflowAssetMatchText(role.assetRef) === normalizeWorkflowAssetMatchText(dialog.roleAssetRef));
    const variantName = stringFromWorkflowValue(dialog.variantName).trim();
    const outfitPrompt = stringFromWorkflowValue(dialog.outfitPrompt).trim();
    const shots = workflowManualOutfitShotOptions(run, summary);
    const apiKeyId = stringFromWorkflowValue(dialog.autoMatchLlmKeyId).trim();
    const selectedApi = llmKeys.find((key) => key.id === apiKeyId) || null;
    const models = workflowLlmModelOptions(selectedApi);
    const model = models.some((item) => item.id === dialog.autoMatchModelId)
      ? dialog.autoMatchModelId
      : models[0]?.id || "";
    if (!baseRole || !variantName || !outfitPrompt || !shots.length || !apiKeyId || !model) {
      setActionMessage("请先填写基础角色、版本名、变装描述，并选择检测 LLM 渠道和模型。");
      return;
    }
    setMatchingManualOutfit(true);
    setActionMessage("正在自动匹配适用镜头...");
    try {
      const result = await generateText({
        apiKeyId,
        model,
        taskType: "workflow-manual-outfit-shot-match",
        messages: [
          { role: "system", content: "你是短视频分镜角色服装状态匹配助手。只返回合法 JSON，不返回 Markdown、解释或代码块。" },
          { role: "user", content: buildWorkflowManualOutfitShotMatchPrompt({ baseRole, variantName, outfitPrompt, shots, script: summary.script || run.scriptOutput || "" }) },
        ],
      });
      const content = extractWorkflowLlmContent(result?.data || result);
      const parsed = parseWorkflowJsonObject(content);
      const matched = uniqueWorkflowNumberList(parsed?.shotIndexes || parsed?.shots || parsed?.shotRefs || parsed?.适用镜头 || []);
      const validShotSet = new Set(shots.map((shot) => Number(shot.index)).filter(Boolean));
      const nextShotRefs = matched.filter((shotIndex) => validShotSet.has(shotIndex));
      setManualOutfitDialog((current) => current ? {
        ...current,
        matchMode: "auto",
        autoMatchLlmKeyId: apiKeyId,
        autoMatchModelId: model,
        shotRefs: nextShotRefs,
      } : current);
      setActionMessage(nextShotRefs.length ? `已自动匹配 ${nextShotRefs.length} 个镜头，可检查后添加版本。` : "AI 没有匹配到适用镜头，可切回手动勾选。");
    } catch (error) {
      setActionMessage(error.message || "自动匹配镜头失败。");
    } finally {
      setMatchingManualOutfit(false);
    }
  }

  async function handleAddManualOutfitVariant(dialog = {}) {
    if (!ecommerceWorkflow || savingManualOutfit || workflowRunHasLiveJob(run)) return;
    const roleOptions = workflowManualOutfitRoleOptions(run, summary);
    const baseRole = roleOptions.find((role) => normalizeWorkflowAssetMatchText(role.assetRef) === normalizeWorkflowAssetMatchText(dialog.roleAssetRef));
    const variantName = stringFromWorkflowValue(dialog.variantName).trim();
    const outfitPrompt = stringFromWorkflowValue(dialog.outfitPrompt).trim();
    const shotRefs = uniqueWorkflowNumberList(dialog.shotRefs);
    if (!baseRole || !variantName || !outfitPrompt || !shotRefs.length) {
      setActionMessage("请完整填写基础角色、版本名、适用镜头和变装描述。");
      return;
    }
    setSavingManualOutfit(true);
    setActionMessage("正在添加变装角色版本...");
    try {
      const currentShots = Array.isArray(run.shots) && run.shots.length ? run.shots : Array.isArray(summary.shots) ? summary.shots : [];
      const variantAsset = buildWorkflowManualOutfitVariantAsset(baseRole, {
        variantName,
        outfitPrompt,
        shotRefs,
      }, currentShots);
      const selectedShotSet = new Set(shotRefs);
      const baseRoleRefKey = normalizeWorkflowAssetMatchText(workflowShotAssetRef(baseRole, 0));
      const nextShots = [
        ...currentShots.map((shot) => (
          normalizeWorkflowAssetMatchText(workflowShotAssetRef(shot, 0)) === baseRoleRefKey
            ? {
                ...shot,
                shotRefs: (Array.isArray(shot.shotRefs) ? shot.shotRefs : []).filter((shotRef) => !selectedShotSet.has(Number(shotRef))),
              }
            : shot
        )),
        variantAsset,
      ];
      const nextRefsByShot = workflowShotAssetRefsWithManualOutfitVariant(run, summary, baseRole, variantAsset, shotRefs);
      const nextShotAssetRefs = workflowShotAssetRefsObject(nextRefsByShot);
      const nextOutfitSummary = workflowRoleOutfitVariantSummary({
        ...run,
        shots: nextShots,
        roleOutfitVariantSummary: {
          enabled: true,
          status: "pending",
        },
      }) || {
        enabled: true,
        status: "pending",
        variantCount: 1,
        generatedCount: 0,
        pendingCount: 1,
        failedCount: 0,
        variantTitles: [variantAsset.title],
      };
      const updated = await updateWorkflowRun(run.id, {
        status: run.status === "error" ? "waiting" : run.status,
        stages: {
          ...(run.stages || {}),
          image: "pending",
          videoPrompt: "pending",
          video: "pending",
          draft: "pending",
        },
        result: workflowRunResultSnapshot(run, {
          shots: nextShots,
          shotAssetRefs: nextShotAssetRefs,
          roleOutfitVariantStatus: nextOutfitSummary.status || "pending",
          roleOutfitVariantSummary: nextOutfitSummary,
          timeline: {},
          videoTimeline: [],
          videoResults: [],
          draft: {},
          draftStatus: "",
          draftUrl: "",
          draftId: "",
          draftError: "",
          ...workflowResetImagePackageResult(),
          ...workflowResetVideoPackageResult(),
        }),
        error: "",
      });
      if (updated?.run) onRunChange(normalizeWorkflowRun(updated.run));
      await onRefresh();
      setManualOutfitDialog(null);
      setActionMessage("变装版本已添加，适用镜头已更新；可点击“生成缺失图片”生成角色图。");
    } catch (error) {
      setActionMessage(error.message || "变装版本添加失败。");
    } finally {
      setSavingManualOutfit(false);
    }
  }

  async function handleQueueImages(options = {}) {
    const shotIds = Array.isArray(options.shotIds) ? options.shotIds.filter(Boolean) : missingImageShots.map(workflowShotId).filter(Boolean);
    const forceRegenerate = Boolean(options.forceRegenerate);
    if (!hasShotResult || imageRunning || queueingImages || !shotIds.length) return;
    const nextVisualStylePayload = workflowVisualStylePayload(workflow, visualStyles, options);
    const imagePromptOverrides = workflowImagePromptOverrides(run, shotIds, nextVisualStylePayload.visualStylePrompt);
    setQueueingImages(true);
    setActionMessage(forceRegenerate ? "正在提交图片重生任务..." : "正在提交分镜图片生成任务...");
    setActiveTab("image");
    try {
      const queueResult = await queueWorkflowNode(run.id, "image", {
        workflowId: run.workflowId,
        title: forceRegenerate ? "分镜图片重生" : "分镜图片生成",
        payload: {
          shotIds,
          forceRegenerate,
          imageKeyId: options.imageKeyId || workflow?.imageKeyId || "",
          imageModelId: options.imageModelId || workflow?.imageModelId || "",
          ...nextVisualStylePayload,
          imagePromptOverrides,
          promptMode: "create-compatible",
          imageResolution: options.imageResolution || workflow?.imageResolution || "",
          ratio: options.ratio || workflow?.ratio || "",
          imageSize: options.imageSize || workflow?.imageSize || workflowImageRequestSize(options.ratio || workflow?.ratio),
          customSize: options.customSize || workflow?.customSize || "",
          roleImageStyleId: normalizeWorkflowRoleImageStyleId(options.roleImageStyleId || workflow?.roleImageStyleId || defaultWorkflowRoleImageStyleId),
          roleImageCustomStylePrompt: options.roleImageCustomStylePrompt || "",
          source: forceRegenerate ? "manual-regenerate-image" : "manual-missing-images",
        },
      });
      const queuedRun = normalizeWorkflowRun(queueResult?.run || run);
      const backendJobs = objectFromWorkflowValue(queuedRun.backendJobs);
      const updated = await updateWorkflowRun(run.id, {
        status: "running",
        completedAt: "",
        stages: {
          ...(queuedRun.stages || {}),
          image: "running",
          audio: talkingVideoWorkflow ? queuedRun.stages?.audio || "done" : "pending",
          videoPrompt: "pending",
          video: "pending",
          draft: "pending",
        },
        result: workflowRunResultSnapshot(queuedRun, {
          shots: workflowShotsWithPendingImages(queuedRun.shots, shotIds, { forceRegenerate }),
          ...(talkingVideoWorkflow ? {} : workflowResetAudioResult()),
          videoTimeline: [],
          videoResults: [],
          draft: {},
          draftStatus: "",
          draftUrl: "",
          draftId: "",
          draftError: "",
          videoPackage: {},
          videoPackageStatus: "",
          videoPackageName: "",
          videoPackageDetail: "",
          videoPackageError: "",
          ...workflowResetImagePackageResult(),
          backendJobs: {
            ...backendJobs,
            image: queueResult?.job || backendJobs.image,
          },
        }),
        error: "",
      });
      if (updated?.run) onRunChange(normalizeWorkflowRun(updated.run));
      await onRefresh();
      setImageSelectionActive(false);
      setSelectedImageIds([]);
      setImageRetryDialog(null);
      setActionMessage(forceRegenerate ? "图片重生已进入队列。" : "分镜图片生成已进入队列。");
    } catch (error) {
      setActionMessage(error.message || "图片生成任务提交失败。");
    } finally {
      setQueueingImages(false);
    }
  }

  async function handleDeleteImages(shotIds, label = "分镜图片") {
    const ids = shotIds.filter(Boolean);
    if (!ids.length || workflowRunHasLiveJob(run)) {
      setActionMessage("当前工作流节点正在运行，暂时不能删除分镜图片。");
      return;
    }
    const targetLabel = label || "图片";
    const confirmed = await requestActionDialog({
      mode: "confirm",
      title: "删除分镜图片",
      summary: `确定删除选中的 ${ids.length} 张${targetLabel}吗？`,
      target: targetLabel,
      hint: "删除后可通过“生成缺失图片”重新生成，并会重置后续视频提示和制作状态；已有视频任务和视频结果会保留。",
      confirmText: "确认删除",
      tone: "danger",
    });
    if (!confirmed) return;
    setActionMessage("正在删除分镜图片...");
    const selectedSet = new Set(ids);
    const shots = (run.shots || []).map((shot) => {
      if (!selectedSet.has(workflowShotId(shot))) return shot;
      return {
        ...shot,
        imageUrl: "",
        imageThumbnailUrl: "",
        fileUrl: "",
        url: "",
        imageStatus: "pending",
        imageError: "",
        imagePauseReason: "",
        imageProviderTaskId: "",
        imageProviderChannel: "",
        imageProviderStatus: "",
        imageProviderLastSyncedAt: "",
        imageRegenerateNonce: createWorkflowLocalId("image"),
      };
    });
    try {
      const updated = await updateWorkflowRun(run.id, {
        status: run.status === "error" ? "waiting" : run.status,
        stages: {
          ...(run.stages || {}),
          image: shots.some((shot) => !workflowShotImageUrl(shot)) ? "pending" : "done",
          videoPrompt: "pending",
          video: "pending",
          draft: "pending",
        },
        result: workflowRunResultSnapshot(run, {
          shots,
          backendJobs: {
            ...objectFromWorkflowValue(run.backendJobs),
            image: {},
          },
          videoTimeline: [],
          videoResults: [],
          draft: {},
          draftStatus: "",
          draftUrl: "",
          draftError: "",
          videoPackage: {},
          videoPackageStatus: "",
          videoPackageName: "",
          videoPackageDetail: "",
          videoPackageError: "",
          ...workflowResetImagePackageResult(),
        }),
        error: "",
      });
      if (updated?.run) onRunChange(normalizeWorkflowRun(updated.run));
      await onRefresh();
      setSelectedImageIds((current) => current.filter((id) => !selectedSet.has(id)));
      setActionMessage("分镜图片已删除，可重新生成缺失图片。");
    } catch (error) {
      setActionMessage(error.message || "图片删除失败。");
    }
  }

  async function handleSaveImagePrompt(shot, nextPrompt) {
    const shotId = workflowShotId(shot);
    const prompt = shot?.assetType === "role"
      ? stripWorkflowRoleImageStyle(nextPrompt)
      : String(nextPrompt || "").trim();
    if (!shotId || !prompt || savingImagePromptId || workflowRunHasLiveJob(run)) {
      if (!prompt) setActionMessage("图片提示词不能为空。");
      return;
    }
    setSavingImagePromptId(shotId);
    setActionMessage("正在保存图片提示词...");
    try {
      const shots = (run.shots || []).map((item) => (
        workflowShotId(item) === shotId
          ? {
              ...item,
              imagePrompt: prompt,
              prompt,
              imagePromptEditedAt: new Date().toISOString(),
            }
          : item
      ));
      const updated = await updateWorkflowRun(run.id, {
        result: workflowRunResultSnapshot(run, {
          shots,
        }),
        error: "",
      });
      if (updated?.run) onRunChange(normalizeWorkflowRun(updated.run));
      await onRefresh();
      setActionMessage("图片提示词已保存，可重新生成这个镜头。");
    } catch (error) {
      setActionMessage(error.message || "图片提示词保存失败。");
      throw error;
    } finally {
      setSavingImagePromptId("");
    }
  }

  async function handleUploadProductImage(shot, files) {
    const shotId = workflowShotId(shot);
    const file = Array.from(files || []).find((item) => item?.type?.startsWith("image/"));
    if (!shotId || !file || uploadingProductImageId || workflowRunHasLiveJob(run)) return;
    const productAsset = await workflowProductAssetForShot(workflowForType, shot);
    const productAssetId = workflowProductAssetId(shot, productAsset);
    if (!productAssetId) {
      setActionMessage("没有找到这个商品图对应的产品资产，无法回写商品库。");
      return;
    }

    setUploadingProductImageId(shotId);
    setActionMessage("正在上传商品图...");
    try {
      const uploadResult = await uploadAssetFiles([file]);
      const uploaded = Array.isArray(uploadResult.files) ? uploadResult.files[0] : null;
      const imageUrl = uploadedProductImageUrl(uploaded);
      if (!imageUrl) throw new Error("商品图已上传，但没有返回可用地址。");

      const imagePatch = {
        productImageUrl: uploaded?.url || uploaded?.fileUrl || imageUrl,
        productImageThumbnailUrl: uploaded?.thumbnailUrl || uploaded?.thumbnail_url || uploaded?.thumbUrl || uploaded?.url || imageUrl,
        productImageKey: uploaded?.key || uploaded?.fileKey || "",
        productImageName: file.name || uploaded?.name || "商品图",
        productImageMimeType: uploaded?.mimeType || file.type || "",
        productImageSizeBytes: Number(uploaded?.sizeBytes || file.size || 0) || 0,
      };
      const nextProductAsset = workflowProductAssetWithImage(productAsset, shot, productAssetId, imagePatch);
      await saveAsset("product", workflowProductAssetSavePayload(nextProductAsset));

      const nextShots = workflowShotsWithProductImage(run.shots || [], shot, nextProductAsset);
      const nextWorkflowSnapshot = workflowSnapshotWithProductImage(workflowSnapshotFromRun(run) || workflowForType, nextProductAsset);
      await syncWorkflowProductSnapshot(workflowForType, nextWorkflowSnapshot);

      const remainingMissing = nextShots.filter((item) => workflowShotRequiresGeneratedImage(item) && !workflowShotImageUrl(item));
      const nextImageStage = remainingMissing.length
        ? remainingMissing.some((item) => item.imageStatus !== "paused" && (item.imageError || item.imageStatus === "error")) ? "error" : "pending"
        : "done";
      const nextImageError = nextImageStage === "error"
        ? remainingMissing.find((item) => item.imageError)?.imageError || stringFromWorkflowValue(run.imageError || run.error)
        : "";
      const updated = await updateWorkflowRun(run.id, {
        status: nextImageStage === "error" ? "error" : "waiting",
        stages: {
          ...(run.stages || {}),
          image: nextImageStage,
          videoPrompt: "pending",
          video: "pending",
          draft: "pending",
        },
        result: workflowRunResultSnapshot(run, {
          workflowSnapshot: nextWorkflowSnapshot,
          shots: nextShots,
          imageError: nextImageError,
          videoTimeline: [],
          videoResults: [],
          draft: {},
          draftStatus: "",
          draftUrl: "",
          draftId: "",
          draftError: "",
          videoPackage: {},
          videoPackageStatus: "",
          videoPackageName: "",
          videoPackageDetail: "",
          videoPackageError: "",
          ...workflowResetImagePackageResult(),
          ...workflowResetVideoPackageResult(),
        }),
        error: nextImageError,
      });
      if (updated?.run) onRunChange(normalizeWorkflowRun(updated.run));
      await onRefresh();
      setActionMessage(nextImageStage === "done" ? "商品图已补充，图片阶段已恢复完成。" : "商品图已补充，仍有其他图片需要处理。");
    } catch (error) {
      setActionMessage(error.message || "商品图上传失败。");
    } finally {
      setUploadingProductImageId("");
    }
  }

  async function handleUploadRoleImage(shot, files) {
    const shotId = workflowShotId(shot);
    const file = Array.from(files || []).find((item) => item?.type?.startsWith("image/"));
    if (!shotId || shot?.assetType !== "role" || !file || uploadingRoleImageId || workflowRunHasLiveJob(run)) return;

    setUploadingRoleImageId(shotId);
    setActionMessage("正在上传角色图...");
    try {
      const uploadResult = await uploadAssetFiles([file]);
      const uploaded = Array.isArray(uploadResult.files) ? uploadResult.files[0] : null;
      const imageUrl = uploadedProductImageUrl(uploaded);
      if (!imageUrl) throw new Error("角色图已上传，但没有返回可用地址。");
      const imageThumbnailUrl = uploaded?.thumbnailUrl || uploaded?.thumbnail_url || uploaded?.thumbUrl || uploaded?.url || imageUrl;
      const shots = (run.shots || []).map((item) => {
        if (workflowShotId(item) !== shotId) return item;
        const { roleNameWatermark, ...rest } = item;
        return {
          ...rest,
          imageUrl,
          imageThumbnailUrl,
          fileUrl: "",
          url: "",
          imageStatus: "done",
          imageSource: "manual-upload",
          imageError: "",
          imagePauseReason: "",
          imageProviderTaskId: "",
          imageProviderChannel: "",
          imageProviderStatus: "",
          imageProviderLastSyncedAt: "",
          uploadedImageName: file.name || uploaded?.name || "角色图",
          uploadedImageKey: uploaded?.key || uploaded?.fileKey || "",
          uploadedImageMimeType: uploaded?.mimeType || file.type || "",
          uploadedImageSizeBytes: Number(uploaded?.sizeBytes || file.size || 0) || 0,
          imageCompletedAt: new Date().toISOString(),
        };
      });
      const imageStage = shots.every((item) => workflowShotImageUrl(item)) ? "done" : "pending";
      const updated = await updateWorkflowRun(run.id, {
        status: run.status === "error" ? "waiting" : run.status,
        stages: {
          ...(run.stages || {}),
          image: imageStage,
          videoPrompt: "pending",
          video: "pending",
          draft: "pending",
        },
        result: workflowRunResultSnapshot(run, {
          shots,
          videoTimeline: [],
          videoResults: [],
          draft: {},
          draftStatus: "",
          draftUrl: "",
          draftId: "",
          draftError: "",
          videoPackage: {},
          videoPackageStatus: "",
          videoPackageName: "",
          videoPackageDetail: "",
          videoPackageError: "",
          ...workflowResetImagePackageResult(),
          ...workflowResetVideoPackageResult(),
        }),
        error: "",
      });
      if (updated?.run) onRunChange(normalizeWorkflowRun(updated.run));
      await onRefresh();
      setActionMessage(imageStage === "done" ? "角色图已上传，图片阶段已完成。" : "角色图已上传，仍有其他图片需要处理。");
    } catch (error) {
      setActionMessage(error.message || "角色图上传失败。");
    } finally {
      setUploadingRoleImageId("");
    }
  }

  function openRoleWatermarkDialog(shotIds = [], assetType = "role") {
    const normalizedAssetType = assetType === "scene" ? "scene" : "role";
    const assetLabel = normalizedAssetType === "scene" ? "场景图" : "角色图";
    if (workflowRunHasLiveJob(run)) {
      setActionMessage(`当前工作流节点正在运行，暂时不能给${assetLabel}增加水印。`);
      return;
    }
    const selectedSet = new Set((Array.isArray(shotIds) ? shotIds : [shotIds]).map(String).filter(Boolean));
    const candidates = (run.shots || [])
      .filter((shot) => shot?.assetType === normalizedAssetType && workflowShotImageUrl(shot))
      .filter((shot) => !selectedSet.size || selectedSet.has(workflowShotId(shot)));
    const candidateIds = candidates.map(workflowShotId).filter(Boolean);
    if (!candidateIds.length) {
      setActionMessage(`当前没有可增加水印的${assetLabel}。`);
      return;
    }
    setRoleWatermarkDialog({
      shotIds: candidateIds,
      targetCount: candidateIds.length,
      assetType: normalizedAssetType,
      watermarkMode: normalizedAssetType,
      customText: "",
    });
  }

  async function handleApplyRoleNameWatermark(shotIds = [], options = {}) {
    if (workflowRunHasLiveJob(run)) {
      setActionMessage("当前工作流节点正在运行，暂时不能给角色图增加水印。");
      return;
    }
    const assetType = options.assetType === "scene" || options.watermarkMode === "scene" ? "scene" : "role";
    const assetLabel = assetType === "scene" ? "场景图" : "角色图";
    const watermarkMode = options.watermarkMode === "custom" || options.mode === "custom" ? "custom" : assetType;
    const customText = workflowWatermarkCustomText(options.customText || options.text || "");
    if (watermarkMode === "custom" && !customText) {
      setActionMessage("请输入自定义水印文字。");
      return;
    }
    const selectedSet = new Set((Array.isArray(shotIds) ? shotIds : [shotIds]).map(String).filter(Boolean));
    const candidates = (run.shots || [])
      .filter((shot) => shot?.assetType === assetType && workflowShotImageUrl(shot))
      .filter((shot) => !selectedSet.size || selectedSet.has(workflowShotId(shot)));
    const targets = candidates
      .map((shot) => ({
        shot,
        shotId: workflowShotId(shot),
        currentImageUrl: workflowShotImageUrl(shot),
        imageUrl: workflowRoleNameWatermarkSourceUrl(shot, workflowShotImageUrl(shot)),
        thumbnailUrl: workflowShotThumbnailUrl(shot),
        text: watermarkMode === "custom"
          ? customText
          : assetType === "scene"
            ? workflowSceneNameWatermarkText(shot)
            : workflowRoleNameWatermarkText(shot),
        watermarkMode,
      }))
      .filter((item) => item.shotId && item.imageUrl && item.text)
      .filter((item) => !workflowRoleNameWatermarkCurrent(item.shot, item.text, item.currentImageUrl));

    if (!candidates.length) {
      setActionMessage(`当前没有可增加水印的${assetLabel}。`);
      return;
    }
    if (!targets.length) {
      setActionMessage("选中的角色图已经带有当前水印。");
      return;
    }

    setWatermarkingRoleImageIds(targets.map((item) => item.shotId));
    setActionMessage(`正在给 ${targets.length} 张${assetLabel}增加水印...`);
    try {
      const updates = [];
      for (let index = 0; index < targets.length; index += 1) {
        const target = targets[index];
        setActionMessage(`正在给${assetLabel}增加水印 ${index + 1}/${targets.length}：${target.text}`);
        const result = await watermarkToolImage({
          url: target.imageUrl,
          text: target.text,
          fileName: `${target.text}-${target.shotId.slice(0, 8)}`,
        });
        const image = result?.image || {};
        const nextImageUrl = image.imageUrl || image.url || image.fileUrl || "";
        if (!nextImageUrl) throw new Error(`“${target.text}”增加水印后没有返回图片地址。`);
        updates.push({
          ...target,
          nextImageUrl,
          nextThumbnailUrl: image.imageThumbnailUrl || image.thumbnailUrl || "",
          appliedAt: new Date().toISOString(),
        });
      }

      const updatedShots = workflowShotsWithRoleNameWatermarks(run.shots || [], updates);
      const updatedVideoTimeline = workflowVideoTimelineWithRoleNameWatermarks(run.videoTimeline || [], updates);
      const updated = await updateWorkflowRun(run.id, {
        status: run.status === "error" ? "waiting" : run.status,
        stages: {
          ...(run.stages || {}),
          video: "pending",
          draft: "pending",
        },
        result: workflowRunResultSnapshot(run, {
          shots: updatedShots,
          videoTimeline: updatedVideoTimeline,
          videoResults: [],
          draft: {},
          draftStatus: "",
          draftUrl: "",
          draftId: "",
          draftError: "",
          videoPackage: {},
          videoPackageStatus: "",
          videoPackageName: "",
          videoPackageDetail: "",
          videoPackageError: "",
          ...workflowResetImagePackageResult(),
        }),
        error: "",
      });
      if (updated?.run) onRunChange(normalizeWorkflowRun(updated.run));
      await onRefresh();
      setActionMessage(`已给 ${updates.length} 张${assetLabel}增加水印。`);
    } catch (error) {
      setActionMessage(error.message || `${assetLabel}增加水印失败。`);
    } finally {
      setWatermarkingRoleImageIds([]);
    }
  }

  async function handleRemoveRoleNameWatermark(shotIds = []) {
    if (workflowRunHasLiveJob(run)) {
      setActionMessage("当前工作流节点正在运行，暂时不能取消水印。");
      return;
    }
    const selectedSet = new Set((Array.isArray(shotIds) ? shotIds : [shotIds]).map(String).filter(Boolean));
    const targets = (run.shots || [])
      .filter((shot) => ["role", "scene"].includes(shot?.assetType) && workflowRoleNameWatermarkRestorable(shot))
      .filter((shot) => !selectedSet.size || selectedSet.has(workflowShotId(shot)))
      .map((shot) => ({
        shot,
        shotId: workflowShotId(shot),
        currentImageUrl: workflowShotImageUrl(shot),
        sourceImageUrl: workflowRoleNameWatermarkSourceUrl(shot, ""),
        sourceThumbnailUrl: workflowRoleNameWatermarkSourceThumbnailUrl(shot),
      }))
      .filter((item) => item.shotId && item.sourceImageUrl);
    const targetLabel = targets.length && targets.every((item) => item.shot?.assetType === "scene") ? "场景图" : "角色图";

    if (!targets.length) {
      setActionMessage("当前没有可取消水印的角色图或场景图。");
      return;
    }

    setRestoringRoleImageIds(targets.map((item) => item.shotId));
    setActionMessage(`正在取消 ${targets.length} 张${targetLabel}的水印...`);
    try {
      const updatedShots = workflowShotsWithoutRoleNameWatermarks(run.shots || [], targets);
      const updatedVideoTimeline = workflowVideoTimelineWithoutRoleNameWatermarks(run.videoTimeline || [], targets);
      const updated = await updateWorkflowRun(run.id, {
        status: run.status === "error" ? "waiting" : run.status,
        stages: {
          ...(run.stages || {}),
          video: "pending",
          draft: "pending",
        },
        result: workflowRunResultSnapshot(run, {
          shots: updatedShots,
          videoTimeline: updatedVideoTimeline,
          videoResults: [],
          draft: {},
          draftStatus: "",
          draftUrl: "",
          draftId: "",
          draftError: "",
          videoPackage: {},
          videoPackageStatus: "",
          videoPackageName: "",
          videoPackageDetail: "",
          videoPackageError: "",
          ...workflowResetImagePackageResult(),
        }),
        error: "",
      });
      if (updated?.run) onRunChange(normalizeWorkflowRun(updated.run));
      await onRefresh();
      setActionMessage(`已取消 ${targets.length} 张${targetLabel}的水印。`);
    } catch (error) {
      setActionMessage(error.message || "取消角色图水印失败。");
    } finally {
      setRestoringRoleImageIds([]);
    }
  }

  async function handleDownloadSelectedImages() {
    const selectedSet = new Set(selectedImageIds);
    const selectedShots = (run.shots || []).filter((shot) => selectedSet.has(workflowShotId(shot)) && workflowShotImageUrl(shot));
    if (!selectedShots.length || downloadingImages) {
      setActionMessage("请先选择要下载的图片。");
      return;
    }
    setDownloadingImages(true);
    const initialJob = {
      status: "running",
      done: 0,
      total: selectedShots.length,
      progress: 4,
      detail: `准备打包 ${selectedShots.length} 张分镜图片`,
      fileName: "",
      downloadPath: "",
      error: "",
    };
    setImagePackageJob(initialJob);
    setActionMessage(`正在打包 ${selectedShots.length} 张分镜图片...`);
    try {
      const created = await createImageZipJob(workflowImageZipPayload(run, selectedShots));
      let job = created.job;
      if (job) setImagePackageJob(job);
      while (job?.status === "running" || job?.status === "queued") {
        setActionMessage(job.detail || `正在打包图片 ${job.done || 0}/${job.total || selectedShots.length}...`);
        await workflowDelay(1000);
        const result = await getImageZipJob(job.id);
        job = result.job;
        if (job) setImagePackageJob(job);
      }
      if (job?.status !== "done" || !job.downloadPath) throw new Error(job?.error || "图片压缩包创建失败。");
      setImagePackageJob(job);
      const updated = await updateWorkflowRun(run.id, {
        status: run.status === "error" ? "waiting" : run.status,
        result: workflowRunResultSnapshot(run, workflowImagePackageResult(job)),
      });
      if (updated?.run) onRunChange(normalizeWorkflowRun(updated.run));
      setActionMessage(`压缩包已打包完成，可在下方点击下载。`);
    } catch (error) {
      const errorJob = {
        ...(imagePackageJob || initialJob),
        status: "error",
        progress: 100,
        detail: error.message || "图片打包失败。",
        error: error.message || "图片打包失败。",
      };
      setImagePackageJob((current) => ({
        ...(current || initialJob),
        ...errorJob,
      }));
      await updateWorkflowRun(run.id, {
        result: workflowRunResultSnapshot(run, workflowImagePackageResult(errorJob)),
      }).catch(() => {});
      setActionMessage(error.message || "图片打包失败。");
    } finally {
      setDownloadingImages(false);
    }
  }

  async function handleDeleteImagePackage(job = imagePackageJob) {
    const jobId = job?.id || job?.jobId || run.imagePackageTaskId || "";
    if (!job && !run.imagePackageStatus) return;
    const confirmed = await requestActionDialog({
      mode: "confirm",
      title: "删除下载链接",
      summary: "删除后这个分镜图片压缩包链接会失效，你可以重新选择图片再打包。",
      target: job?.fileName || run.imagePackageName || "分镜图片压缩包",
      hint: "只会删除压缩包下载链接，不会删除已经生成的分镜图片。",
      confirmText: "确认删除",
      tone: "danger",
    });
    if (!confirmed) return;
    setActionMessage("正在删除压缩包下载链接...");
    try {
      if (jobId) await deleteImageZipJob(jobId);
    } catch (error) {
      if (!/404|不存在|not found/i.test(error.message || "")) {
        setActionMessage(error.message || "删除压缩包链接失败。");
        return;
      }
    }
    const updated = await updateWorkflowRun(run.id, {
      result: workflowRunResultSnapshot(run, workflowResetImagePackageResult()),
    }).catch(() => null);
    if (updated?.run) onRunChange(normalizeWorkflowRun(updated.run));
    setImagePackageJob(null);
    await onRefresh();
    setActionMessage("压缩包下载链接已删除，可重新打包。");
  }

  function openVideoGroupingDialog() {
    const imageReadyShots = (run.shots || []).filter((shot) => workflowShotImageUrl(shot));
    if (!imageReadyShots.length || imageReadyShots.length !== (run.shots || []).length) {
      setActionMessage("请先完成全部分镜图片，再添加到视频时间线。");
      return;
    }
    if (workflowRunHasLiveJob(run) || videoTimelineTask?.status === "running") {
      setActionMessage("当前工作流节点正在运行，暂时不能添加视频时间线。");
      return;
    }
    if (summary.videoTimeline.length) {
      showVideoTimelineMustClearDialog();
      return;
    }
    if (summary.storyboardMode === "ai-director") {
      void handleAddVideoTimeline({ mode: "ai-director-assemble" });
      return;
    }
    const storyboardCount = ecommerceWorkflow ? ecommerceStoryboardShots(summary.script || summary.shotOutput).length : 0;
    setVideoGroupingDialog({
      total: ecommerceWorkflow ? storyboardCount : imageReadyShots.length,
      mode: "quick",
      groupSize: 1,
      ecommerce: ecommerceWorkflow,
    });
  }

  async function handleAddVideoTimeline(options = 1) {
    const aiDirector = options && typeof options === "object"
      && ["ai-director", "ai-director-assemble"].includes(options.mode);
    const groupSize = aiDirector ? 1 : Number(options?.groupSize || options) || 1;
    const imageReadyShots = (run.shots || []).filter((shot) => workflowShotImageUrl(shot));
    if (!imageReadyShots.length || imageReadyShots.length !== (run.shots || []).length) {
      setActionMessage("请先完成全部分镜图片，再添加到视频时间线。");
      return;
    }
    if (workflowRunHasLiveJob(run)) {
      setActionMessage("当前工作流节点正在运行，暂时不能添加视频时间线。");
      return;
    }
    if (summary.videoTimeline.length) {
      showVideoTimelineMustClearDialog();
      return;
    }
    if (aiDirector) {
      setVideoGroupingDialog(null);
      setVideoTimelineTask({
        mode: "ai-director",
        status: "submitting",
        progress: 5,
        done: 0,
        total: 0,
        indeterminate: true,
        detail: "正在按本地文件名排序绑定图片，并组装 AI 导演视频提示词。",
      });
      setActionMessage("正在组装 AI 导演视频提示词...");
      try {
        const queueResult = await queueWorkflowNode(run.id, "videoPrompt", {
          maxDurationSeconds: summary.aiDirectorMaxDurationSeconds || 15,
          videoPromptMode: "ai-director-assemble",
        });
        if (queueResult?.run) onRunChange(normalizeWorkflowRun(queueResult.run));
        setVideoTimelineTask((current) => current?.mode === "ai-director" ? {
          ...current,
          status: "running",
          jobId: queueResult?.job?.id || "",
        } : current);
        await onRefresh();
        setActionMessage("AI 导演视频提示词正在组装，完成后会自动刷新。");
      } catch (error) {
        setVideoTimelineTask({
          mode: "ai-director",
          status: "error",
          progress: 100,
          done: 0,
          total: 0,
          detail: error.message || "AI 导演视频提示词组装任务提交失败。",
          error: error.message || "AI 导演视频提示词组装任务提交失败。",
        });
        setActionMessage(error.message || "AI 导演视频提示词组装任务提交失败。");
      }
      return;
    }
    const timeline = ecommerceWorkflow
      ? workflowEcommerceVideoTimeline(
        { ...run, shots: imageReadyShots },
        summary,
        groupSize,
        workflowStoryboardShotDurationSeconds(workflowForType),
      )
      : workflowVideoTimelineGroups(imageReadyShots, groupSize);
    if (!timeline.length) {
      setActionMessage(ecommerceWorkflow ? "没有解析到可用于视频制作的分镜脚本详情。" : "没有可添加的视频时间线片段。");
      return;
    }
    setVideoGroupingDialog(null);
    setVideoTimelineTask({
      status: "running",
      progress: 8,
      done: 0,
      total: timeline.length,
      detail: "正在添加视频时间线",
    });
    setActionMessage("正在按分组同步图片到视频时间线...");
    try {
      for (let index = 0; index < timeline.length; index += 1) {
        setVideoTimelineTask({
          status: "running",
          progress: Math.max(8, Math.round(((index + 1) / timeline.length) * 92)),
          done: index + 1,
          total: timeline.length,
          detail: `已处理 ${index + 1}/${timeline.length} 个${ecommerceWorkflow ? "镜头片段" : "分镜组"}`,
        });
        await workflowDelay(120);
      }
      const updated = await updateWorkflowRun(run.id, {
        status: run.status === "error" ? "waiting" : run.status,
        stages: {
          ...(run.stages || {}),
          videoPrompt: "pending",
          video: "pending",
          draft: "pending",
        },
        result: workflowRunResultSnapshot(run, {
          videoTimeline: timeline,
          videoResults: [],
          timeline: workflowTimelineFromAudio({ ...run, shots: imageReadyShots }, summary.audio || buildWorkflowAudioFromManualInput({ audioUrl: summary.audioUrl, duration: summary.audioDuration }, workflowFinalScriptText(summary))),
          draft: {},
          draftStatus: "",
          draftUrl: "",
          draftError: "",
          ...workflowResetVideoPackageResult(),
        }),
        error: "",
      });
      if (updated?.run) onRunChange(normalizeWorkflowRun(updated.run));
      await onRefresh();
      setVideoPackageJob(null);
      setVideoResultPackageJob(null);
      setVideoTimelineTask({
        status: "done",
        progress: 100,
        done: timeline.length,
        total: timeline.length,
        detail: `已生成 ${timeline.length} 个${ecommerceWorkflow ? "镜头片段" : "分镜组"}`,
      });
      setActionMessage("视频时间线已添加。");
      window.setTimeout(() => {
        setVideoTimelineTask((current) => current?.status === "done" ? null : current);
      }, 1600);
    } catch (error) {
      setVideoTimelineTask({
        status: "error",
        progress: 100,
        done: 0,
        total: timeline.length,
        detail: error.message || "视频时间线添加失败。",
        error: error.message || "视频时间线添加失败。",
      });
      setActionMessage(error.message || "视频时间线添加失败。");
    }
  }

  async function handleClearVideoTimeline() {
    if (!summary.videoTimeline.length) return;
    if (workflowRunHasLiveJob(run)) {
      setActionMessage("当前工作流节点正在运行，暂时不能清空视频时间线。");
      return;
    }
    const confirmed = await requestActionDialog({
      mode: "confirm",
      title: "清空视频时间线",
      summary: `确认清空 ${summary.videoTimeline.length} 个分镜组吗？`,
      target: title,
      hint: "后续视频结果会恢复为未完成。",
      confirmText: "确认清空",
      tone: "danger",
    });
    if (!confirmed) return;
    setActionMessage("正在清空视频时间线...");
    try {
      const updated = await updateWorkflowRun(run.id, {
        status: run.status === "error" ? "waiting" : run.status,
        stages: {
          ...(run.stages || {}),
          videoPrompt: "pending",
          video: "pending",
          draft: "pending",
        },
        result: workflowRunResultSnapshot(run, {
          videoTimeline: [],
          videoResults: [],
          draft: {},
          draftStatus: "",
          draftUrl: "",
          draftError: "",
          ...workflowResetVideoPackageResult(),
        }),
        error: "",
      });
      if (updated?.run) onRunChange(normalizeWorkflowRun(updated.run));
      await onRefresh();
      setVideoPackageJob(null);
      setVideoResultPackageJob(null);
      setActionMessage("视频时间线已清空。");
    } catch (error) {
      setActionMessage(error.message || "视频时间线清空失败。");
    }
  }

  async function handleAssembleVideoPrompts() {
    const timeline = summary.videoTimeline;
    if (!timeline.length) return;
    if (workflowRunHasLiveJob(run)) {
      setActionMessage("当前工作流节点正在运行，暂时不能组装视频提示词。");
      return;
    }
    if (workflowVideoTimelineHasAiDirectorOutput(timeline)) {
      showVideoTimelineMustClearDialog("当前视频时间线已经包含 AI 导演生成的视频提示词，不能再次组装覆盖。");
      return;
    }
    if (workflowHasTouchedAfterStage(run, "videoPrompt", workflowForType) || run.videoPackageStatus) {
      const confirmed = await requestActionDialog({
        mode: "confirm",
        title: "覆盖视频提示词",
        summary: "组装后会覆盖现有视频提示词，并清空后续视频结果和制作资料。",
        target: title,
        hint: "确认后会按当前视频时间线重新组装提示词。",
        confirmText: "确认组装",
        tone: "danger",
      });
      if (!confirmed) return;
    }
    setActionMessage("正在组装视频提示词...");
    const nextTimeline = timeline.map((item) => ({
      ...item,
      videoPrompt: workflowVideoSegmentPrompt(item),
    }));
    try {
      const updated = await updateWorkflowRun(run.id, {
        status: run.status === "error" ? "waiting" : run.status,
        stages: {
          ...(run.stages || {}),
          videoPrompt: "done",
          video: "pending",
          draft: "pending",
        },
        result: workflowRunResultSnapshot(run, {
          videoTimeline: nextTimeline,
          videoResults: [],
          draft: {},
          draftStatus: "",
          draftUrl: "",
          draftError: "",
          ...workflowResetVideoPackageResult(),
        }),
        error: "",
      });
      if (updated?.run) onRunChange(normalizeWorkflowRun(updated.run));
      await onRefresh();
      setVideoPackageJob(null);
      setVideoResultPackageJob(null);
      setActionMessage("视频提示词已组装。");
    } catch (error) {
      setActionMessage(error.message || "视频提示词组装失败。");
    }
  }

  function showVideoTimelineMustClearDialog(summaryText = "当前视频时间线已有内容，不能直接重新添加或覆盖。") {
    void requestActionDialog({
      mode: "notice",
      title: "请先清空现有视频时间线",
      summary: summaryText,
      target: `${summary.videoTimeline.length} 个现有片段`,
      hint: "请先点击“清空所有分镜”，确认清空后再重新添加到时间线。",
      confirmText: "知道了",
      tone: "danger",
    });
  }

  function handleStartEditVideoPrompt(item, index) {
    if (workflowRunHasLiveJob(run)) {
      setActionMessage("当前工作流节点正在运行，暂时不能编辑视频提示词。");
      return;
    }
    const promptId = workflowTimelineItemId(item, index);
    setEditingVideoPromptId(promptId);
    setVideoPromptDraft(stringFromWorkflowValue(item.videoPrompt));
  }

  function handleCancelEditVideoPrompt() {
    setEditingVideoPromptId("");
    setVideoPromptDraft("");
    setSavingVideoPromptId("");
  }

  async function handleSaveVideoPrompt(item, index) {
    const promptId = workflowTimelineItemId(item, index);
    if (!promptId || savingVideoPromptId || workflowRunHasLiveJob(run)) return;
    const nextPrompt = String(videoPromptDraft || "").trim();
    setSavingVideoPromptId(promptId);
    setActionMessage("正在保存视频提示词...");
    try {
      const currentRun = runRef.current || run;
      const currentSummary = summaryRef.current || summary;
      const promptSaveState = buildWorkflowVideoPromptSaveState({
        timeline: currentSummary.videoTimeline,
        videoResults: currentSummary.videoResults,
        promptId,
        nextPrompt,
      });
      const videoStatus = workflowVideoStageFromResults(promptSaveState.videoResults, promptSaveState.videoTimeline);
      const updated = await updateWorkflowRun(currentRun.id, {
        status: currentRun.status === "error" ? "waiting" : currentRun.status,
        stages: {
          ...(currentRun.stages || {}),
          videoPrompt: promptSaveState.videoTimeline.every((entry) => stringFromWorkflowValue(entry.videoPrompt).trim()) ? "done" : "pending",
          video: videoStatus,
        },
        result: workflowRunResultSnapshot(currentRun, {
          ...promptSaveState,
          videoStatus,
        }),
        error: "",
      });
      if (updated?.run) onRunChange(normalizeWorkflowRun(updated.run));
      await onRefresh();
      setEditingVideoPromptId("");
      setVideoPromptDraft("");
      setActionMessage(nextPrompt ? "视频提示词已保存，已有视频结果已保留。" : "视频提示词已清空，已有视频结果已保留。");
    } catch (error) {
      setActionMessage(error.message || "视频提示词保存失败。");
    } finally {
      setSavingVideoPromptId("");
    }
  }

  async function handleCopyVideoPrompt(item) {
    const prompt = stringFromWorkflowValue(item?.videoPrompt).trim();
    if (!prompt) {
      setActionMessage("当前镜头还没有视频提示词可复制。");
      return;
    }
    await copyWorkflowText(prompt);
    setActionMessage("视频提示词已复制。");
  }

  async function handleDeleteVideoTimelineItem(item, index) {
    if (workflowRunHasLiveJob(run)) {
      setActionMessage("当前工作流节点正在运行，暂时不能删除镜头。");
      return;
    }
    const target = workflowVideoTargetFromTimelineItem(item, index);
    const confirmed = await requestActionDialog({
      mode: "confirm",
      title: "删除镜头",
      summary: `确认删除 ${target.title} 吗？`,
      target: item?.title || item?.shotTitle || target.title,
      hint: "会同步删除这个镜头对应的视频任务和旧下载包，后续剪辑草稿会恢复为未完成。",
      confirmText: "确认删除",
      tone: "danger",
    });
    if (!confirmed) return;
    setActionMessage("正在删除镜头...");
    try {
      const targetId = workflowTimelineItemId(item, index);
      const nextTimeline = summary.videoTimeline.filter((entry, entryIndex) => (
        workflowTimelineItemId(entry, entryIndex) !== targetId
      ));
      const nextResults = (Array.isArray(summary.videoResults) ? summary.videoResults : [])
        .filter((video) => !workflowVideoResultMatchesTarget(video, target));
      const videoStatus = workflowVideoStageFromResults(nextResults, nextTimeline);
      const updated = await updateWorkflowRun(run.id, {
        status: run.status === "error" ? "waiting" : run.status,
        stages: {
          ...(run.stages || {}),
          videoPrompt: nextTimeline.length && nextTimeline.every((entry) => workflowVideoSegmentAssets(entry).length && stringFromWorkflowValue(entry.videoPrompt).trim()) ? "done" : "pending",
          video: videoStatus,
          draft: "pending",
        },
        result: workflowRunResultSnapshot(run, {
          videoTimeline: nextTimeline,
          videoResults: nextResults,
          videoStatus,
          draft: {},
          draftStatus: "",
          draftUrl: "",
          draftError: "",
          ...workflowResetVideoPackageResult(),
        }),
        error: "",
      });
      if (updated?.run) onRunChange(normalizeWorkflowRun(updated.run));
      await onRefresh();
      setVideoPackageJob(null);
      setVideoResultPackageJob(null);
      if (editingVideoPromptId === targetId) handleCancelEditVideoPrompt();
      setActionMessage(`${target.title} 已删除。`);
    } catch (error) {
      setActionMessage(error.message || "镜头删除失败。");
    }
  }

  async function handleDeleteVideoTimelineAsset(item, index, asset, assetIndex) {
    if (workflowRunHasLiveJob(run)) {
      setActionMessage("当前工作流节点正在运行，暂时不能删除参考图片。");
      return;
    }
    const target = workflowVideoTargetFromTimelineItem(item, index);
    const assetName = workflowVideoAssetDisplayName(asset, assetIndex);
    const confirmed = await requestActionDialog({
      mode: "confirm",
      title: "删除参考图片",
      summary: `确认从 ${target.title} 删除“${assetName}”吗？`,
      target: item?.title || item?.shotTitle || target.title,
      hint: "会同步清空这个镜头对应的视频结果和旧下载包，后续剪辑草稿会恢复为未完成。",
      confirmText: "确认删除",
      tone: "danger",
    });
    if (!confirmed) return;
    setActionMessage("正在删除参考图片...");
    try {
      const targetId = workflowTimelineItemId(item, index);
      let removed = false;
      const nextTimeline = summary.videoTimeline.map((entry, entryIndex) => {
        if (workflowTimelineItemId(entry, entryIndex) !== targetId) return entry;
        const nextEntry = workflowVideoTimelineItemWithoutAsset(entry, asset);
        removed = workflowVideoSegmentAssets(nextEntry).length !== workflowVideoSegmentAssets(entry).length;
        return nextEntry;
      });
      if (!removed) {
        setActionMessage("没有找到要删除的参考图片。");
        return;
      }
      const nextResults = (Array.isArray(summary.videoResults) ? summary.videoResults : [])
        .filter((video) => !workflowVideoResultMatchesTarget(video, target));
      const videoStatus = workflowVideoStageFromResults(nextResults, nextTimeline);
      const updated = await updateWorkflowRun(run.id, {
        status: run.status === "error" ? "waiting" : run.status,
        stages: {
          ...(run.stages || {}),
          videoPrompt: nextTimeline.length && nextTimeline.every((entry) => stringFromWorkflowValue(entry.videoPrompt).trim()) ? "done" : "pending",
          video: videoStatus,
          draft: "pending",
        },
        result: workflowRunResultSnapshot(run, {
          videoTimeline: nextTimeline,
          videoResults: nextResults,
          videoStatus,
          draft: {},
          draftStatus: "",
          draftUrl: "",
          draftError: "",
          ...workflowResetVideoPackageResult(),
        }),
        error: "",
      });
      if (updated?.run) onRunChange(normalizeWorkflowRun(updated.run));
      await onRefresh();
      setVideoPackageJob(null);
      setVideoResultPackageJob(null);
      setActionMessage(`已从 ${target.title} 删除“${assetName}”。`);
    } catch (error) {
      setActionMessage(error.message || "参考图片删除失败。");
    }
  }

  function openVideoGenerateDialog(item, index) {
    const candidates = workflowVideoModelCandidates(videoKeys);
    if (!candidates.length) {
      setActionMessage("请先在 API 设置里添加可用的视频生成 API Key。");
      return;
    }
    const dialog = workflowVideoGenerateDialogState(item, index, candidates);
    setVideoGenerateDialog(dialog);
  }

  function openMissingVideoGenerateDialog() {
    const candidates = workflowVideoModelCandidates(videoKeys);
    if (!candidates.length) {
      setActionMessage("请先在 API 设置里添加可用的视频生成 API Key。");
      return;
    }
    const targets = workflowVideoMissingTargets(summary.videoTimeline, summary.videoResults);
    if (!targets.length) {
      setActionMessage("当前没有缺失的视频。");
      return;
    }
    setVideoGenerateDialog(workflowVideoGenerateDialogState(targets[0].item, targets[0].index, candidates, {
      mode: "missing",
      targets,
    }));
  }

  function currentWorkflowVideoResults() {
    return Array.isArray(videoResultsRef.current) ? videoResultsRef.current : [];
  }

  function findCurrentWorkflowVideoResult(video = {}) {
    return findWorkflowVideoResultInList(currentWorkflowVideoResults(), video);
  }

  async function persistWorkflowVideoResultUpdate(video, updater, options = {}) {
    const videoId = workflowVideoResultId(video);
    if (videoId && deletedVideoResultIdsRef.current.has(videoId)) return null;
    return await persistWorkflowVideoResults((results) => {
      if (videoId && deletedVideoResultIdsRef.current.has(videoId)) return results;
      const current = findWorkflowVideoResultInList(results, video);
      if (!current) return results;
      const nextVideo = typeof updater === "function" ? updater(current) : { ...current, ...updater };
      return upsertWorkflowVideoResult(results, nextVideo);
    }, options);
  }

  async function persistWorkflowVideoResults(nextResultsOrUpdater, options = {}) {
    const persist = async () => {
      const currentResults = currentWorkflowVideoResults();
      const resolvedResults = typeof nextResultsOrUpdater === "function"
        ? nextResultsOrUpdater(currentResults)
        : nextResultsOrUpdater;
      const normalizedResults = typeof nextResultsOrUpdater === "function"
        ? (Array.isArray(resolvedResults) ? resolvedResults : [])
        : mergeWorkflowVideoResultLists(currentResults, resolvedResults);
      const videoResultRemovals = currentResults.filter((video) => (
        !findWorkflowVideoResultInList(normalizedResults, video)
      ));
      videoResultsRef.current = normalizedResults;
      const currentRun = runRef.current || run;
      const currentSummary = summaryRef.current || summary;
      const videoStatus = workflowVideoStageFromResults(normalizedResults, currentSummary.videoTimeline);
      const updated = await updateWorkflowRun(currentRun.id, {
        status: currentRun.status === "error" ? "waiting" : currentRun.status,
        stages: {
          ...(currentRun.stages || {}),
          video: videoStatus,
          draft: "pending",
        },
        resultPatch: {
          videoResults: normalizedResults,
          videoStatus,
          draft: {},
          draftStatus: "",
          draftUrl: "",
          draftId: "",
          draftError: "",
          ...workflowResetVideoResultPackageResult(),
        },
        videoResultRemovals,
        error: "",
      });
      if (updated?.run) onRunChange(normalizeWorkflowRun(updated.run));
      setVideoResultPackageJob(null);
      if (options.message) setActionMessage(options.message);
      return updated;
    };
    const operation = videoPersistQueueRef.current.catch(() => {}).then(persist);
    videoPersistQueueRef.current = operation.catch(() => {});
    return await operation;
  }

  async function handleConfirmVideoGenerate(dialog) {
    const candidate = workflowVideoSelectedCandidate(dialog, videoKeys);
    if (!candidate) {
      setActionMessage("请选择可用的视频生成模型。");
      return;
    }
    const targets = workflowVideoDialogTargets(dialog);
    if (!targets.length) {
      setActionMessage("没有可生成的视频片段。");
      return;
    }
    const preparedTargets = targets.map((target) => {
      const prompt = workflowVideoPromptForItem(target.item);
      const references = workflowVideoReferenceUrlsForItem(target.item, candidate.model, dialog.generationMode);
      const targetDialog = workflowVideoDialogForTarget(dialog, target, prompt);
      return {
        target,
        prompt,
        references,
        queuedResult: workflowVideoResultFromDialog(targetDialog, candidate, {
          references,
          status: "queued",
        }),
      };
    });
    const missingPrompt = preparedTargets.find((target) => !target.prompt);
    if (missingPrompt) {
      setActionMessage(`${missingPrompt.target.title} 缺少视频提示词，请先在视频制作页补充。`);
      return;
    }
    const requiredReferenceCount = workflowVideoRequiredReferenceCount(candidate.model, dialog.generationMode);
    const missingReference = requiredReferenceCount
      ? preparedTargets.find((target) => target.references.length < requiredReferenceCount)
      : null;
    if (missingReference) {
      setActionMessage(`${missingReference.target.title} 至少需要 ${requiredReferenceCount} 张可用参考图，暂时不能生成视频。`);
      return;
    }
    const submitId = dialog.mode === "missing" ? workflowVideoBatchSubmitId : preparedTargets[0]?.target.timelineItemId;
    if (!submitId || submittingVideoSegmentId) return;
    setSubmittingVideoSegmentId(submitId);
    setVideoGenerateDialog(null);
    setActiveTab("videoResult");
    try {
      const queued = await queueWorkflowVideoTasks(run.id, {
        tasks: preparedTargets.map((target) => ({
          video: target.queuedResult,
          request: {
            apiKeyId: candidate.apiKey.id,
            channel: candidate.apiKey.channel,
            modelId: candidate.model.modelId,
            modelProvider: candidate.model.provider,
            prompt: target.prompt,
            ratio: dialog.ratio,
            resolution: dialog.resolution,
            duration: dialog.duration,
            generationMode: dialog.generationMode,
            frames: target.references,
          },
        })),
      });
      if (queued?.run) onRunChange(normalizeWorkflowRun(queued.run));
      setActionMessage(`已加入后台队列 ${preparedTargets.length} 个视频任务，关闭浏览器后仍会继续提交。`);
    } catch (error) {
      setActionMessage(error.message || "视频后台队列创建失败。");
    } finally {
      setSubmittingVideoSegmentId("");
    }
  }

  async function handleDeleteWorkflowVideoResult(video, index) {
    const videoId = workflowVideoResultId(video);
    const confirmed = await requestActionDialog({
      mode: "confirm",
      tone: "danger",
      title: "删除视频任务",
      summary: "删除后会从当前工作流的视频结果中移除这条记录；如果任务已经提交到上游模型服务，上游生成任务不会被取消。",
      target: workflowVideoTitle(video, index),
      confirmText: "确认删除",
    });
    if (!confirmed) return;
    if (videoId) {
      pollingVideoResultIdsRef.current.delete(videoId);
      deletedVideoResultIdsRef.current.add(videoId);
    }
    try {
      setActionMessage("正在删除视频任务...");
      await persistWorkflowVideoResults((results) => workflowVideoResultsWithout(results, video, index), { message: "视频任务已删除。" });
    } catch (error) {
      if (videoId) deletedVideoResultIdsRef.current.delete(videoId);
      setActionMessage(error.message || "视频任务删除失败。");
    }
  }

  async function handleDeleteWorkflowVideoResults(videos = []) {
    if (!videos.length) return;
    const confirmed = await requestActionDialog({
      mode: "confirm",
      tone: "danger",
      title: "批量删除视频任务",
      summary: "删除后会从当前工作流的视频结果中移除这些记录；已经提交到上游模型服务的生成任务不会被取消。",
      target: `${videos.length} 个视频任务`,
      confirmText: "确认删除",
    });
    if (!confirmed) return;
    const deletedVideoIds = videos.map((video) => {
      const videoId = workflowVideoResultId(video);
      if (!videoId) return "";
      pollingVideoResultIdsRef.current.delete(videoId);
      deletedVideoResultIdsRef.current.add(videoId);
      return videoId;
    }).filter(Boolean);
    try {
      setActionMessage("正在批量删除视频任务...");
      await persistWorkflowVideoResults((results) => workflowVideoResultsWithoutMany(results, videos), { message: `已删除 ${videos.length} 个视频任务。` });
    } catch (error) {
      deletedVideoIds.forEach((videoId) => deletedVideoResultIdsRef.current.delete(videoId));
      setActionMessage(error.message || "视频任务批量删除失败。");
    }
  }

  async function handleDownloadWorkflowVideoResults(videos = []) {
    const completedVideos = videos.filter((video) => workflowVideoUrl(video));
    if (!completedVideos.length || downloadingVideoResults) return;
    const initialJob = {
      status: "running",
      done: 0,
      total: completedVideos.length,
      progress: 8,
      detail: `准备打包 ${completedVideos.length} 个视频`,
      fileName: "",
      downloadPath: "",
      error: "",
    };
    setDownloadingVideoResults(true);
    setVideoResultPackageJob(initialJob);
    setActionMessage(`正在创建 ${completedVideos.length} 个视频的下载任务...`);
    try {
      await updateWorkflowRun(run.id, {
        status: run.status === "error" ? "waiting" : run.status,
        result: workflowRunResultSnapshot(run, workflowVideoResultPackageResult({
          ...initialJob,
          detail: "正在创建视频结果压缩包",
        })),
      });
      const created = await createFileZipJob(workflowVideoDownloadZipPayload(run, completedVideos));
      let job = created.job;
      if (job) setVideoResultPackageJob(job);
      while (job?.status === "running" || job?.status === "queued") {
        setActionMessage(job.detail || `正在打包视频 ${job.done || 0}/${job.total || completedVideos.length}...`);
        await workflowDelay(1000);
        const result = await getFileZipJob(job.id);
        job = result.job;
        if (job) setVideoResultPackageJob(job);
      }
      if (job?.status !== "done" || !job.downloadPath) throw new Error(job?.error || "视频结果压缩包创建失败。");
      setVideoResultPackageJob(job);
      const updated = await updateWorkflowRun(run.id, {
        status: run.status === "error" ? "waiting" : run.status,
        result: workflowRunResultSnapshot(run, workflowVideoResultPackageResult(job)),
      });
      if (updated?.run) onRunChange(normalizeWorkflowRun(updated.run));
      setActionMessage(`视频结果下载任务已创建，下载链接 ${workflowPackageExpiresText(job.expiresAt)}。`);
    } catch (error) {
      const errorJob = {
        ...(videoResultPackageJob || initialJob),
        status: "error",
        progress: 100,
        detail: error.message || "视频结果压缩包创建失败。",
        error: error.message || "视频结果压缩包创建失败。",
      };
      setVideoResultPackageJob((current) => ({
        ...(current || initialJob),
        ...errorJob,
      }));
      await updateWorkflowRun(run.id, {
        result: workflowRunResultSnapshot(run, workflowVideoResultPackageResult(errorJob)),
      }).catch(() => {});
      setActionMessage(error.message || "视频结果压缩包创建失败。");
    } finally {
      setDownloadingVideoResults(false);
    }
  }

  async function handleDeleteVideoResultPackage(job = videoResultPackageJob) {
    const jobId = job?.id || job?.jobId || run.videoResultPackageTaskId || "";
    if (!job && !run.videoResultPackageStatus) return;
    const confirmed = await requestActionDialog({
      mode: "confirm",
      title: "删除下载链接",
      summary: "删除后，这个视频结果压缩包链接会失效；需要时可以重新创建下载任务。",
      target: job?.fileName || run.videoResultPackageName || "视频结果压缩包",
      confirmText: "确认删除",
      tone: "danger",
    });
    if (!confirmed) return;
    setActionMessage("正在删除视频结果下载链接...");
    try {
      if (jobId) await deleteFileZipJob(jobId).catch(() => {});
      setVideoResultPackageJob(null);
      const updated = await updateWorkflowRun(run.id, {
        result: workflowRunResultSnapshot(run, workflowResetVideoResultPackageResult()),
      });
      if (updated?.run) onRunChange(normalizeWorkflowRun(updated.run));
      setActionMessage("视频结果下载链接已删除。");
    } catch (error) {
      setActionMessage(error.message || "视频结果下载链接删除失败。");
    }
  }

  async function syncWorkflowVideoResult(video, options = {}) {
    const videoId = workflowVideoResultId(video);
    if (videoId && deletedVideoResultIdsRef.current.has(videoId)) return;
    const current = findCurrentWorkflowVideoResult(video) || video;
    const taskId = stringFromWorkflowValue(current.taskId || current?.meta?.taskId);
    if (!taskId) {
      if (!options.background) setActionMessage("这个视频还在本地排队中，尚未提交到模型服务。");
      return;
    }
    if (!options.force && !workflowVideoResultNeedsPolling(current)) return;
    try {
      const result = await queryVideoToolTask(current.apiKeyId, taskId);
      if (videoId && deletedVideoResultIdsRef.current.has(videoId)) return;
      const nextVideo = workflowVideoResultFromToolResult(current, result);
      await persistWorkflowVideoResultUpdate(current, nextVideo, {
        message: options.background ? "" : workflowVideoStatusMessage(nextVideo),
      });
    } catch (error) {
      if (options.background) return;
      const nextVideo = {
        ...current,
        recentQueryError: error.message || "视频任务查询失败。",
        queryError: error.message || "视频任务查询失败。",
        lastQueriedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await persistWorkflowVideoResultUpdate(current, nextVideo, {
        message: nextVideo.recentQueryError,
      });
    }
  }

  async function handleQueryWorkflowVideoResult(video) {
    const videoId = workflowVideoSelectableId(video);
    if (!videoId || queryingVideoResultIds.includes(videoId)) return;
    setQueryingVideoResultIds((current) => current.includes(videoId) ? current : [...current, videoId]);
    try {
      await syncWorkflowVideoResult(video, { background: false, force: true });
    } finally {
      setQueryingVideoResultIds((current) => current.filter((id) => id !== videoId));
    }
  }

  async function handleRecoverWorkflowVideoTaskId(video, taskId) {
    const nextTaskId = stringFromWorkflowValue(taskId).trim();
    if (!nextTaskId) {
      setActionMessage("请输入模型渠道后台里的任务 ID。");
      return;
    }
    const videoId = workflowVideoSelectableId(video);
    if (videoId && queryingVideoResultIds.includes(videoId)) return;
    setQueryingVideoResultIds((current) => videoId && !current.includes(videoId) ? [...current, videoId] : current);
    try {
      const current = findCurrentWorkflowVideoResult(video) || video;
      await persistWorkflowVideoResultUpdate(current, {
        ...current,
        taskId: nextTaskId,
        recoveryTaskId: nextTaskId,
        recentQueryError: "",
        queryError: "",
        updatedAt: new Date().toISOString(),
      }, {
        message: "已关联上游任务 ID，正在查询结果...",
      });
      await syncWorkflowVideoResult({ ...current, taskId: nextTaskId }, { background: false, force: true });
    } catch (error) {
      setActionMessage(error.message || "关联 Canvas 任务 ID 失败。");
    } finally {
      setQueryingVideoResultIds((current) => current.filter((id) => id !== videoId));
    }
  }

  async function handleResumeWorkflowVideoQueue(videos = []) {
    const targets = (Array.isArray(videos) && videos.length ? videos : currentWorkflowVideoResults())
      .filter(workflowVideoResultIsPausedQueued);
    if (!targets.length) return;
    try {
      const queued = await queueWorkflowVideoTasks(run.id, {
        tasks: targets.map((target) => {
          const current = findCurrentWorkflowVideoResult(target) || target;
          return {
            video: {
              ...current,
              status: "queued",
              message: "",
              queuePaused: false,
              queuePauseReason: "",
              queuePausedAt: "",
              updatedAt: new Date().toISOString(),
            },
            request: {
              apiKeyId: current.apiKeyId,
              channel: current.channel,
              modelId: current.modelId,
              modelProvider: current.provider,
              prompt: current.prompt,
              ratio: current.ratio,
              resolution: current.resolution,
              duration: current.duration,
              generationMode: current.generationMode,
              frames: workflowVideoReferenceUrlsFromResult(current),
            },
          };
        }),
      });
      if (queued?.run) onRunChange(normalizeWorkflowRun(queued.run));
      setActionMessage(`已恢复 ${targets.length} 个视频任务到后台队列。`);
    } catch (error) {
      setActionMessage(error.message || "视频后台队列恢复失败。");
    }
  }

  async function handlePackVideoMaterials() {
    const timeline = summary.videoTimeline;
    if (!timeline.length || packagingVideoMaterials) return;
    if (workflowRunHasLiveJob(run)) {
      setActionMessage("当前工作流节点正在运行，暂时不能打包制作资料。");
      return;
    }
    const total = workflowVideoMaterialAssetCount({ videoTimeline: timeline });
    const initialJob = {
      status: "running",
      done: 0,
      total,
      progress: 8,
      detail: "正在整理图片和提示词清单",
      fileName: "",
      downloadPath: "",
      error: "",
    };
    setPackagingVideoMaterials(true);
    setBrowserVideoPackageJob(null);
    setVideoPackageJob(initialJob);
    setActionMessage("正在打包视频制作资料...");
    try {
      await updateWorkflowRun(run.id, {
        status: run.status === "error" ? "waiting" : run.status,
        result: workflowRunResultSnapshot(run, {
          videoPackageStatus: "running",
          videoPackageDetail: "正在整理图片和提示词清单",
          videoPackageName: "",
          videoPackageError: "",
          videoPackage: {},
        }),
      });
      const created = await createImageZipJob(workflowVideoMaterialsZipPayload({ ...run, videoTimeline: timeline }));
      let job = created.job;
      if (job) setVideoPackageJob(job);
      while (job?.status === "running" || job?.status === "queued") {
        setActionMessage(job.detail || `正在打包制作资料 ${job.done || 0}/${job.total || total}...`);
        await workflowDelay(1000);
        const result = await getImageZipJob(job.id);
        job = result.job;
        if (job) setVideoPackageJob(job);
      }
      if (job?.status !== "done" || !job.downloadPath) throw new Error(job?.error || "视频制作资料打包失败。");
      const updated = await updateWorkflowRun(run.id, {
        status: run.status === "error" ? "waiting" : run.status,
        result: workflowRunResultSnapshot(run, {
          videoPackage: {
            status: "done",
            fileName: job.fileName,
            name: job.fileName,
            downloadPath: job.downloadPath,
            expiresAt: job.expiresAt || 0,
          },
          videoPackageStatus: "done",
          videoPackageName: job.fileName,
          videoPackageDetail: "压缩包已创建，可以下载制作资料。",
          videoPackageError: "",
        }),
      });
      if (updated?.run) onRunChange(normalizeWorkflowRun(updated.run));
      setVideoPackageJob(job);
      setActionMessage("视频制作资料已打包完成，可点击下载。");
    } catch (error) {
      setVideoPackageJob((current) => ({
        ...(current || initialJob),
        status: "error",
        progress: 100,
        detail: error.message || "视频制作资料打包失败。",
        error: error.message || "视频制作资料打包失败。",
      }));
      await updateWorkflowRun(run.id, {
        result: workflowRunResultSnapshot(run, {
          videoPackageStatus: "error",
          videoPackageDetail: "",
          videoPackageError: error.message || "视频制作资料打包失败。",
        }),
      }).catch(() => {});
      setActionMessage(error.message || "视频制作资料打包失败。");
    } finally {
      setPackagingVideoMaterials(false);
      await onRefresh();
    }
  }

  async function handleBrowserPackVideoMaterials() {
    const timeline = summary.videoTimeline;
    if (!timeline.length || packagingVideoMaterials || browserPackagingVideoMaterials) return;
    const payload = workflowVideoMaterialsZipPayload({ ...run, videoTimeline: timeline });
    const total = Array.isArray(payload.files) ? payload.files.length : 0;
    const initialJob = {
      status: "running",
      done: 0,
      total,
      progress: 4,
      detail: "正在使用浏览器读取图片，请保持当前页面打开",
      fileName: "",
      error: "",
    };
    setBrowserPackagingVideoMaterials(true);
    setBrowserVideoPackageJob(initialJob);
    setActionMessage("正在使用浏览器打包视频制作资料...");
    try {
      const packageResult = await createBrowserImagePackage(payload, {
        onProgress: (progress) => setBrowserVideoPackageJob((current) => ({
          ...(current || initialJob),
          ...progress,
          status: "running",
        })),
      });
      downloadWorkflowBlob(packageResult.blob, packageResult.fileName);
      setBrowserVideoPackageJob({
        status: "done",
        done: total,
        total,
        progress: 100,
        detail: `浏览器已完成 ${total} 张图片打包，ZIP 已开始下载。`,
        fileName: packageResult.fileName,
        error: "",
      });
      setActionMessage("浏览器本地打包完成，ZIP 已开始下载。请求重新下载时可再次点击浏览器打包。");
    } catch (error) {
      const message = error?.name === "AbortError" ? "浏览器打包已取消。" : error.message || "浏览器本地打包失败。";
      setBrowserVideoPackageJob((current) => ({
        ...(current || initialJob),
        status: "error",
        progress: 100,
        detail: message,
        error: message,
      }));
      setActionMessage(message);
    } finally {
      setBrowserPackagingVideoMaterials(false);
    }
  }

  function toggleImageSelection() {
    const generatedIds = summary.shots.filter((shot) => workflowShotImageUrl(shot)).map(workflowShotId).filter(Boolean);
    const allSelected = imageSelectionActive && selectedImageIds.length === generatedIds.length;
    if (allSelected) {
      setImageSelectionActive(false);
      setSelectedImageIds([]);
      return;
    }
    setImageSelectionActive(true);
    setSelectedImageIds(generatedIds);
  }

  function toggleSelectedImage(shot) {
    if (!imageSelectionActive) return;
    const shotId = workflowShotId(shot);
    if (!shotId || !workflowShotImageUrl(shot)) return;
    setSelectedImageIds((current) => (
      current.includes(shotId) ? current.filter((id) => id !== shotId) : [...current, shotId]
    ));
  }

  async function handleSaveShot(nextShotOutput) {
    const rawOutput = String(nextShotOutput || "").trim();
    const storyboardWorkflow = isStoryboardWorkflow(workflowForType);
    const output = storyboardWorkflow ? ecommerceShotResultTextOnly(rawOutput, summary.script) : rawOutput;
    if (!output || savingShot || workflowRunHasLiveJob(run)) return;
    const confirmed = await requestActionDialog({
      mode: "confirm",
      title: "保存分镜修改",
      summary: talkingVideoWorkflow
        ? "保存分镜修改会清空后续已经生成或报错的图片、视频提示和视频结果，并把它们恢复为未完成状态；已生成音频会保留。"
        : "保存分镜修改会清空后续已经生成或报错的图片、音频、视频提示和视频结果，并把它们恢复为未完成状态。",
      target: title,
      hint: talkingVideoWorkflow ? "确认后会保留新的分镜，并重置图片和视频节点。" : "确认后会保留新的分镜，并重置图片、音频和视频节点。",
      confirmText: "确认保存",
      tone: "danger",
    });
    if (!confirmed) return;
    const shotAssetRefs = storyboardWorkflow ? workflowShotAssetRefsObject(parseEcommerceShotAssetRefs(rawOutput)) : {};
    const shots = storyboardWorkflow ? parseEcommerceMappingImageItems(output, workflowForType, shotAssetRefs) : parseWorkflowShots(output);
    if (!shots.length) throw new Error(storyboardWorkflow ? "没有解析到角色图或场景图映射，请检查格式。" : "没有解析到有效镜头，请检查格式。");
    setSavingShot(true);
    setActionMessage("正在保存分镜修改...");
    try {
      const updated = await updateWorkflowRun(run.id, {
        status: run.status === "error" ? "waiting" : run.status,
        stages: {
          ...(run.stages || {}),
          topic: run.kind === "topic-child" ? "skipped" : run.stages?.topic || "done",
          outline: "skipped",
          script: "done",
          shot: "done",
          image: "pending",
          audio: talkingVideoWorkflow ? run.stages?.audio || "done" : "pending",
          videoPrompt: "pending",
          video: "pending",
          draft: "pending",
        },
        result: workflowRunResultSnapshot(run, workflowResetAfterShotResult({
          shotOutput: output,
          shotAssetRefs,
          shotError: "",
          shots,
        }, { preserveAudio: talkingVideoWorkflow })),
        error: "",
      });
      if (updated?.run) onRunChange(normalizeWorkflowRun(updated.run));
      await onRefresh();
      setActionMessage(talkingVideoWorkflow ? "分镜已保存，图片和视频节点已恢复为未完成，音频已保留。" : "分镜已保存，图片、音频和视频节点已恢复为未完成。");
    } catch (error) {
      setActionMessage(error.message || "分镜保存失败。");
      throw error;
    } finally {
      setSavingShot(false);
    }
  }

  return (
    <section className="workflow-panel-next workflow-run-page-next workflow-run-focused-next workflow-run-result-page-next">
      <div className="workflow-run-focused-head-next">
        <Link className="secondary-action compact workflow-run-back-next" href={workflowBackHref(run)}>
          ← 返回任务
        </Link>
        <div className="workflow-run-title-cluster-next">
          <span className="workflow-run-icon-next text">文</span>
          <div>
            <h2>{title} · 任务结果</h2>
            <p>任务 #{workflowRunShortId(run)}</p>
          </div>
        </div>
        <div className="workflow-run-header-actions-next">
          <div className="workflow-run-header-action-row-next primary" role="group" aria-label="生成操作">
            <button className="secondary-action compact workflow-cover-entry-next" type="button" onClick={() => setCoverDialogOpen(true)}>
              生成封面
            </button>
            <button className="secondary-action compact workflow-draft-entry-next" type="button" disabled={queueingDraft} onClick={openDraftExportDialog}>
              {queueingDraft ? "正在提交剪辑草稿" : draftRunning ? `剪辑草稿生成中 ${summary.draftProgress}%` : summary.draftUrl ? "重新生成剪辑草稿" : "生成剪辑草稿"}
            </button>
            {!hasShotResult && summary.script ? (
              <button className="primary-action compact" type="button" disabled={!canQueueShot} onClick={openShotRegenerateDialog}>
                {queueingShot ? "提交中" : shotRunning ? "分镜生成中" : "继续生成分镜"}
              </button>
            ) : null}
            {hasShotResult ? (
              <button className="primary-action compact" type="button" disabled={!canQueueImages} onClick={openMissingImageDialog}>
                {queueingImages ? "提交中" : imageRunning ? "图片生成中" : "生成缺失图片"}
              </button>
            ) : null}
          </div>
          <div className="workflow-run-header-action-row-next secondary" role="group" aria-label="重新生成操作">
            <button className="secondary-action compact" type="button" disabled={!canQueueScript} onClick={openScriptRegenerateDialog}>
              {queueingScript ? "提交中" : scriptRunning ? "文案生成中" : "重新生成文案"}
            </button>
            {!ecommerceWorkflow && (talkingVideoWorkflow || imageNodeComplete) ? (
              <button className="secondary-action compact" type="button" disabled={!canQueueAudio} onClick={() => openAudioGenerateDialog()}>
                {queueingAudio ? "生成中" : audioRunning ? "音频生成中" : hasAudioResult ? "重新生成音频" : "生成音频"}
              </button>
            ) : null}
            {hasShotResult ? (
              <button className="secondary-action compact" type="button" disabled={!canQueueShot} onClick={openShotRegenerateDialog}>
                {queueingShot ? "提交中" : shotRunning ? "分镜生成中" : "重新生成分镜"}
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="workflow-result-tabs-next" role="tablist" aria-label="任务结果类型">
        {tabs.map((tab) => (
          <button className={`${safeActiveTab === tab.id ? "active" : ""} ${tab.id === "optimize" && optimizationBusy ? "running" : ""}`} type="button" onClick={() => setActiveTab(tab.id)} key={tab.id}>
            {tab.id === "optimize" && optimizationBusy ? <span className="workflow-result-tab-spinner-next" aria-hidden="true"></span> : null}
            {tab.label}
          </button>
        ))}
      </div>

      {actionMessage ? <p className="workflow-run-action-message-next">{actionMessage}</p> : null}
      <RunResultTabBody
        run={run}
        summary={summary}
        activeTab={safeActiveTab}
        workflow={workflowForType}
        readingLanguage={readingLanguage}
        canEditScript={canEditScript}
        canQueueAudio={canQueueAudio}
        savingAudio={savingAudio}
        queueingAudio={queueingAudio}
        canEditShot={canEditShot}
        savingScript={savingScript}
        savingShot={savingShot}
        translatingScript={translatingScript}
        checkingCompliance={checkingCompliance}
        optimizingScript={optimizingScript}
        canQueueShot={canQueueShot}
        queueingShot={queueingShot}
        onSaveScript={handleSaveScript}
        onSaveAudio={handleSaveAudio}
        onQueueAudio={openAudioGenerateDialog}
        onDeleteAudio={handleDeleteAudio}
        onUpdateAudioSrt={handleUpdateAudioSrt}
        onSaveShot={handleSaveShot}
        onTranslateScript={handleTranslateScript}
        onCheckCompliance={openComplianceCheckDialog}
        onOptimizeScript={openOptimizationDialog}
        onSaveOptimizationScript={handleSaveOptimizationScript}
        onActivateOptimizationVersion={handleActivateOptimizationVersion}
        onQueueShot={openShotRegenerateDialog}
        onOpenManualOutfitVariant={openManualOutfitDialog}
        imageSelectionActive={imageSelectionActive}
        selectedImageIds={selectedImageIds}
        onToggleImageSelection={toggleImageSelection}
        onToggleSelectedImage={toggleSelectedImage}
        onPreviewImage={setImagePreview}
        onRegenerateImage={openRegenerateImageDialog}
        onSaveImagePrompt={handleSaveImagePrompt}
        savingImagePromptId={savingImagePromptId}
        uploadingProductImageId={uploadingProductImageId}
        uploadingRoleImageId={uploadingRoleImageId}
        onUploadProductImage={handleUploadProductImage}
        onUploadRoleImage={handleUploadRoleImage}
        onDeleteImage={(shot) => handleDeleteImages([workflowShotId(shot)], "")}
        onDeleteSelectedImages={() => handleDeleteImages(selectedImageIds, "图片")}
        onDownloadSelectedImages={handleDownloadSelectedImages}
        downloadingImages={downloadingImages}
        watermarkingRoleImageIds={watermarkingRoleImageIds}
        restoringRoleImageIds={restoringRoleImageIds}
        onOpenRoleWatermarkDialog={openRoleWatermarkDialog}
        onRemoveRoleNameWatermark={handleRemoveRoleNameWatermark}
        imagePackageJob={imagePackageJob}
        onDeleteImagePackage={handleDeleteImagePackage}
        videoTimelineTask={displayedVideoTimelineTask}
        videoPackageJob={videoPackageJob}
        browserVideoPackageJob={browserVideoPackageJob}
        videoResultPackageJob={videoResultPackageJob}
        packagingVideoMaterials={packagingVideoMaterials}
        browserPackagingVideoMaterials={browserPackagingVideoMaterials}
        onOpenVideoGrouping={openVideoGroupingDialog}
        onClearVideoTimeline={handleClearVideoTimeline}
        onAssembleVideoPrompts={handleAssembleVideoPrompts}
        onPackVideoMaterials={handlePackVideoMaterials}
        onBrowserPackVideoMaterials={handleBrowserPackVideoMaterials}
        onOpenVideoGenerate={openVideoGenerateDialog}
        onOpenMissingVideoGenerate={openMissingVideoGenerateDialog}
        generatingVideoSegmentId={submittingVideoSegmentId}
        onDeleteVideoResult={handleDeleteWorkflowVideoResult}
        onDeleteVideoResults={handleDeleteWorkflowVideoResults}
        onDownloadVideoResults={handleDownloadWorkflowVideoResults}
        onDeleteVideoResultPackage={handleDeleteVideoResultPackage}
        downloadingVideoResults={downloadingVideoResults}
        queryingVideoResultIds={queryingVideoResultIds}
        onQueryVideoResult={handleQueryWorkflowVideoResult}
        onRecoverVideoTaskId={handleRecoverWorkflowVideoTaskId}
        onResumeVideoQueue={handleResumeWorkflowVideoQueue}
        onRefreshVideoResults={onRefresh}
        editingVideoPromptId={editingVideoPromptId}
        videoPromptDraft={videoPromptDraft}
        savingVideoPromptId={savingVideoPromptId}
        onStartEditVideoPrompt={handleStartEditVideoPrompt}
        onChangeVideoPromptDraft={setVideoPromptDraft}
        onCancelEditVideoPrompt={handleCancelEditVideoPrompt}
        onSaveVideoPrompt={handleSaveVideoPrompt}
        onCopyVideoPrompt={handleCopyVideoPrompt}
        onDeleteVideoTimelineItem={handleDeleteVideoTimelineItem}
        onDeleteVideoTimelineAsset={handleDeleteVideoTimelineAsset}
      />
      {imagePreview ? <WorkflowImagePreview image={imagePreview} onClose={() => setImagePreview(null)} /> : null}
      {coverDialogOpen ? (
        <WorkflowCoverDialog
          run={run}
          workflow={workflowForType}
          imageKeys={imageKeys}
          onClose={() => setCoverDialogOpen(false)}
          onRunUpdated={(updatedRun) => onRunChange(normalizeWorkflowRun(updatedRun))}
        />
      ) : null}
      {draftDialog ? (
        <WorkflowDraftDialog
          dialog={draftDialog}
          draftKeys={draftKeys}
          queueing={queueingDraft}
          draftRunning={draftRunning}
          draftProgress={summary.draftProgress}
          draftProgressDetail={summary.draftProgressDetail}
          draftUrl={summary.draftUrl}
          draftId={summary.draftId}
          draftError={draftDialog.localError || summary.draftError}
          runLabel={`任务 #${workflowRunShortId(run)}`}
          previewImageUrl={workflowDraftPreviewImageUrl(summary)}
          onChange={setDraftDialog}
          onClose={() => setDraftDialog(null)}
          onConfirm={handleQueueDraft}
        />
      ) : null}
      {imageRetryDialog ? (
        <WorkflowImageRetryDialog
          dialog={imageRetryDialog}
          imageKeys={imageKeys}
          queueing={queueingImages}
          onChange={setImageRetryDialog}
          onClose={() => setImageRetryDialog(null)}
          onConfirm={(nextDialog) => handleQueueImages(nextDialog)}
        />
      ) : null}
      {roleWatermarkDialog ? (
        <WorkflowRoleWatermarkDialog
          dialog={roleWatermarkDialog}
          onChange={setRoleWatermarkDialog}
          onClose={() => setRoleWatermarkDialog(null)}
          onConfirm={(nextDialog) => {
            setRoleWatermarkDialog(null);
            handleApplyRoleNameWatermark(nextDialog.shotIds, {
              assetType: nextDialog.assetType,
              watermarkMode: nextDialog.watermarkMode,
              customText: nextDialog.customText,
            });
          }}
        />
      ) : null}
      {manualOutfitDialog ? (
        <WorkflowManualOutfitDialog
          dialog={manualOutfitDialog}
          roles={workflowManualOutfitRoleOptions(run, summary)}
          shots={workflowManualOutfitShotOptions(run, summary)}
          saving={savingManualOutfit}
          matching={matchingManualOutfit}
          llmKeys={llmKeys}
          onChange={setManualOutfitDialog}
          onClose={() => setManualOutfitDialog(null)}
          onAutoMatch={handleAutoMatchManualOutfitShots}
          onConfirm={handleAddManualOutfitVariant}
        />
      ) : null}
      {actionDialog ? (
        <WorkflowRunActionDialog
          dialog={actionDialog}
          llmKeys={llmKeys}
          imageKeys={imageKeys}
          audioKeys={audioKeys}
          queueing={queueingScript || queueingAudio || queueingShot || queueingDraft || draftRunning || savingScript || savingShot || checkingCompliance || optimizingScript}
          onChange={setActionDialog}
          onClose={() => closeActionDialog(null)}
          onConfirm={(nextDialog) => {
            if (nextDialog.mode === "script") {
              closeActionDialog(true);
              handleQueueScript({
                llmKeyId: nextDialog.apiId,
                storyModelId: nextDialog.modelId,
                modelId: nextDialog.modelId,
              });
              return;
            }
            if (nextDialog.mode === "compliance") {
              closeActionDialog(true);
              handleCheckCompliance({
                llmKeyId: nextDialog.apiId,
                modelId: nextDialog.modelId,
              });
              return;
            }
            if (nextDialog.mode === "optimization") {
              closeActionDialog(true);
              handleOptimizeScript(nextDialog.customPrompt, {
                llmKeyId: nextDialog.apiId,
                modelId: nextDialog.modelId,
              });
              return;
            }
            if (nextDialog.mode === "shot") {
              closeActionDialog(true);
              handleQueueShot({
                autoImages: Boolean(nextDialog.autoImages),
                storyboardMode: nextDialog.storyboardMode,
                maxDurationSeconds: nextDialog.maxDurationSeconds,
                talkingShotSegmentationMode: nextDialog.talkingShotSegmentationMode,
                llmKeyId: nextDialog.apiId,
                shotModelId: nextDialog.modelId,
                modelId: nextDialog.modelId,
                roleOutfitVariantDetection: Boolean(nextDialog.roleOutfitVariantDetection),
                outfitDetectionLlmKeyId: nextDialog.outfitDetectionLlmKeyId,
                outfitDetectionModelId: nextDialog.outfitDetectionModelId,
                outfitImageKeyId: nextDialog.outfitImageKeyId,
                outfitImageModelId: nextDialog.outfitImageModelId,
                outfitImageResolution: nextDialog.outfitImageResolution,
                outfitImageRatio: nextDialog.outfitImageRatio,
                outfitImageSize: nextDialog.outfitImageSize,
                outfitImageCustomSize: nextDialog.outfitImageCustomSize,
                imageKeyId: nextDialog.imageKeyId,
                imageModelId: nextDialog.imageModelId,
                imageResolution: nextDialog.imageResolution,
                ratio: nextDialog.ratio,
                imageSize: nextDialog.imageSize,
                customSize: nextDialog.customSize,
                ...visualStylePayload,
              });
              return;
            }
            if (nextDialog.mode === "audio") {
              closeActionDialog(true);
              handleQueueAudioVariants(nextDialog.audioVariants, {
                audioKeyId: nextDialog.audioKeyId,
                audioModelId: nextDialog.audioModelId,
                audioFormat: nextDialog.audioFormat,
                audioEmotion: nextDialog.audioEmotion,
                audioBitrate: nextDialog.audioBitrate,
                audioSpeed: nextDialog.audioSpeed,
                audioVoice: nextDialog.audioVoice,
                audioVoicePresetId: nextDialog.audioVoicePresetId,
                audioReferenceId: nextDialog.audioReferenceId,
                audioReferences: nextDialog.audioReferences,
              });
              return;
            }
            if (nextDialog.mode === "audio-confirm") {
              closeActionDialog(true);
              handleQueueAudioVariants(nextDialog.audioVariants);
              return;
            }
            closeActionDialog(true);
          }}
        />
      ) : null}
      {videoGroupingDialog ? (
        <WorkflowVideoGroupingDialog
          dialog={videoGroupingDialog}
          llmKeys={llmKeys}
          onChange={setVideoGroupingDialog}
          onClose={() => setVideoGroupingDialog(null)}
          onConfirm={(options) => handleAddVideoTimeline(options)}
        />
      ) : null}
      {videoGenerateDialog ? (
        <WorkflowVideoGenerateDialog
          dialog={videoGenerateDialog}
          videoKeys={videoKeys}
          submitting={Boolean(submittingVideoSegmentId)}
          onChange={setVideoGenerateDialog}
          onClose={() => setVideoGenerateDialog(null)}
          onConfirm={handleConfirmVideoGenerate}
        />
      ) : null}
    </section>
  );
}

function RunResultTabBody({ run, workflow, summary, activeTab, readingLanguage, canEditScript, canQueueAudio, savingAudio, queueingAudio, canEditShot, savingScript, savingShot, translatingScript, checkingCompliance, optimizingScript, canQueueShot, queueingShot, onSaveScript, onSaveAudio, onQueueAudio, onDeleteAudio, onUpdateAudioSrt, onSaveShot, onTranslateScript, onCheckCompliance, onOptimizeScript, onSaveOptimizationScript, onActivateOptimizationVersion, onQueueShot, onOpenManualOutfitVariant, imageSelectionActive, selectedImageIds, onToggleImageSelection, onToggleSelectedImage, onPreviewImage, onRegenerateImage, onSaveImagePrompt, savingImagePromptId, uploadingProductImageId, uploadingRoleImageId, onUploadProductImage, onUploadRoleImage, onDeleteImage, onDeleteSelectedImages, onDownloadSelectedImages, downloadingImages, watermarkingRoleImageIds, restoringRoleImageIds, onOpenRoleWatermarkDialog, onRemoveRoleNameWatermark, imagePackageJob, onDeleteImagePackage, videoTimelineTask, videoPackageJob, browserVideoPackageJob, videoResultPackageJob, packagingVideoMaterials, browserPackagingVideoMaterials, onOpenVideoGrouping, onClearVideoTimeline, onAssembleVideoPrompts, onPackVideoMaterials, onBrowserPackVideoMaterials, onOpenVideoGenerate, onOpenMissingVideoGenerate, generatingVideoSegmentId, onDeleteVideoResult, onDeleteVideoResults, onDownloadVideoResults, onDeleteVideoResultPackage, downloadingVideoResults, queryingVideoResultIds, onQueryVideoResult, onRecoverVideoTaskId, onResumeVideoQueue, onRefreshVideoResults, editingVideoPromptId, videoPromptDraft, savingVideoPromptId, onStartEditVideoPrompt, onChangeVideoPromptDraft, onCancelEditVideoPrompt, onSaveVideoPrompt, onCopyVideoPrompt, onDeleteVideoTimelineItem, onDeleteVideoTimelineAsset }) {
  const workflowForType = workflow || normalizeWorkflowConfigForRun(null, run);
  if (activeTab === "optimize") return <OptimizationResultSection run={run} workflow={workflow} summary={summary} savingScript={savingScript} checkingCompliance={checkingCompliance} optimizingScript={optimizingScript} onCheckCompliance={onCheckCompliance} onOptimizeScript={onOptimizeScript} onSaveOptimizationScript={onSaveOptimizationScript} onActivateOptimizationVersion={onActivateOptimizationVersion} />;
  if (activeTab === "audio") return <AudioResultSection run={run} workflow={workflow} summary={summary} canQueueAudio={canQueueAudio} savingAudio={savingAudio} queueingAudio={queueingAudio} onSaveAudio={onSaveAudio} onQueueAudio={onQueueAudio} onDeleteAudio={onDeleteAudio} onUpdateAudioSrt={onUpdateAudioSrt} />;
  if (activeTab === "shot") return <ShotResultSection run={run} workflow={workflowForType} summary={summary} canEditShot={canEditShot} savingShot={savingShot} canQueueShot={canQueueShot} queueingShot={queueingShot} onSaveShot={onSaveShot} onQueueShot={onQueueShot} onOpenManualOutfitVariant={onOpenManualOutfitVariant} />;
  if (activeTab === "image") return <ImageResultSection run={run} workflow={workflowForType} summary={summary} selectionActive={imageSelectionActive} selectedImageIds={selectedImageIds} downloadingImages={downloadingImages} watermarkingRoleImageIds={watermarkingRoleImageIds} restoringRoleImageIds={restoringRoleImageIds} imagePackageJob={imagePackageJob} savingImagePromptId={savingImagePromptId} uploadingProductImageId={uploadingProductImageId} uploadingRoleImageId={uploadingRoleImageId} onToggleSelection={onToggleImageSelection} onToggleShot={onToggleSelectedImage} onPreviewImage={onPreviewImage} onRegenerateImage={onRegenerateImage} onOpenManualOutfitVariant={onOpenManualOutfitVariant} onSaveImagePrompt={onSaveImagePrompt} onUploadProductImage={onUploadProductImage} onUploadRoleImage={onUploadRoleImage} onOpenRoleWatermarkDialog={onOpenRoleWatermarkDialog} onRemoveRoleNameWatermark={onRemoveRoleNameWatermark} onDeleteImage={onDeleteImage} onDeleteSelectedImages={onDeleteSelectedImages} onDownloadSelectedImages={onDownloadSelectedImages} onDeleteImagePackage={onDeleteImagePackage} />;
  if (activeTab === "video") return <VideoTimelineSection run={run} workflow={workflowForType} summary={summary} videoTimelineTask={videoTimelineTask} videoPackageJob={videoPackageJob} browserVideoPackageJob={browserVideoPackageJob} packagingVideoMaterials={packagingVideoMaterials} browserPackagingVideoMaterials={browserPackagingVideoMaterials} onOpenVideoGrouping={onOpenVideoGrouping} onClearVideoTimeline={onClearVideoTimeline} onAssembleVideoPrompts={onAssembleVideoPrompts} onPackVideoMaterials={onPackVideoMaterials} onBrowserPackVideoMaterials={onBrowserPackVideoMaterials} onOpenVideoGenerate={onOpenVideoGenerate} onOpenMissingVideoGenerate={onOpenMissingVideoGenerate} generatingVideoSegmentId={generatingVideoSegmentId} editingVideoPromptId={editingVideoPromptId} videoPromptDraft={videoPromptDraft} savingVideoPromptId={savingVideoPromptId} onStartEditVideoPrompt={onStartEditVideoPrompt} onChangeVideoPromptDraft={onChangeVideoPromptDraft} onCancelEditVideoPrompt={onCancelEditVideoPrompt} onSaveVideoPrompt={onSaveVideoPrompt} onCopyVideoPrompt={onCopyVideoPrompt} onDeleteVideoTimelineItem={onDeleteVideoTimelineItem} onDeleteVideoTimelineAsset={onDeleteVideoTimelineAsset} />;
  if (activeTab === "videoResult") return <VideoFinalResultSection summary={summary} videoResultPackageJob={videoResultPackageJob} downloadingVideoResults={downloadingVideoResults} queryingVideoResultIds={queryingVideoResultIds} onRefresh={onRefreshVideoResults} onDeleteVideoResult={onDeleteVideoResult} onDeleteVideoResults={onDeleteVideoResults} onDownloadVideoResults={onDownloadVideoResults} onDeleteVideoResultPackage={onDeleteVideoResultPackage} onQueryVideoResult={onQueryVideoResult} onRecoverVideoTaskId={onRecoverVideoTaskId} onResumeVideoQueue={onResumeVideoQueue} />;
  return <ScriptResultSection run={run} workflow={workflowForType} summary={summary} readingLanguage={readingLanguage} canEditScript={canEditScript} savingScript={savingScript} translatingScript={translatingScript} onSaveScript={onSaveScript} onTranslateScript={onTranslateScript} />;
}

function ScriptResultSection({ run, workflow, summary, readingLanguage, canEditScript, savingScript, translatingScript, onSaveScript, onTranslateScript }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(summary.script || "");
  const [saveError, setSaveError] = useState("");
  const [viewMode, setViewMode] = useState("original");
  const targetLanguage = workflowReadingLanguage(readingLanguage);
  const targetLabel = workflowTranslationTargetLabel(targetLanguage);
  const sourceLanguage = workflowConfiguredLanguage(workflow);
  const sourceLabel = workflowCopyLanguageLabel(sourceLanguage);
  const translationEnabled = isTalkingVideoWorkflow(workflow) && sourceLanguage !== targetLanguage;
  const translationMatches = Boolean(summary.optimizedScript && summary.translationLanguage === targetLanguage);
  const translationRunning = translatingScript || (
    run.scriptTranslationStatus === "running"
      && (!run.scriptTranslationLanguage || run.scriptTranslationLanguage === targetLanguage)
  );
  const translationError = run.scriptTranslationStatus === "error" && run.scriptTranslationLanguage === targetLanguage
    ? run.scriptTranslationError
    : "";
  const canTranslate = Boolean(
    translationEnabled
      && summary.script
      && workflow?.llmKeyId
      && workflow?.storyModelId
      && !translationRunning
      && !workflowRunHasLiveJob(run),
  );

  useEffect(() => {
    setDraft(summary.script || "");
    setEditing(false);
    setSaveError("");
    setViewMode("original");
  }, [run.id, summary.script, targetLanguage]);

  async function handleSave() {
    const nextScript = draft.trim();
    if (!nextScript || savingScript) return;
    setSaveError("");
    try {
      await onSaveScript(nextScript);
      setEditing(false);
    } catch (error) {
      setSaveError(error.message || "文案保存失败。");
    }
  }

  async function handleTranslate() {
    if (!canTranslate) return;
    const translated = await onTranslateScript();
    if (translated) setViewMode("bilingual");
  }

  if (!summary.script) {
    return (
      <section className="workflow-run-section-card-next error">
        <h4>文案生成失败</h4>
        <p>{run.scriptError || run.error || "当前节点还没有生成成功，或没有可展示的文案结果。"}</p>
      </section>
    );
  }

  return (
    <section className="workflow-run-section-card-next">
      <div className="workflow-run-section-title-next compact">
        <div>
          <h4>生成文案</h4>
          <p>{translationEnabled ? `原文始终用于音频和后续节点；${targetLabel}对照仅帮助阅读理解。` : "可复制或进入编辑状态修改文案。"}</p>
        </div>
        <div className="workflow-run-title-actions-next">
          <span>{countWorkflowChars(summary.script)} 字</span>
          {editing ? (
            <>
              <button className="secondary-action compact" type="button" disabled={savingScript} onClick={() => { setEditing(false); setDraft(summary.script); }}>
                取消
              </button>
              <button className="primary-action compact" type="button" disabled={savingScript || !draft.trim()} onClick={handleSave}>
                {savingScript ? "保存中" : "保存文案"}
              </button>
            </>
          ) : (
            <>
              {translationEnabled ? (
                <button className="secondary-action compact" type="button" disabled={!canTranslate} onClick={handleTranslate}>
                  {translationRunning ? "翻译中" : translationMatches ? `重新生成${targetLabel}对照` : `生成${targetLabel}理解对照`}
                </button>
              ) : null}
              <button className="secondary-action compact" type="button" disabled={!canEditScript} onClick={() => setEditing(true)}>
                编辑文案
              </button>
              <CopyButton text={summary.script} label="复制" />
            </>
          )}
        </div>
      </div>
      {editing ? (
        <textarea
          className="workflow-script-editor-next"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={14}
          autoFocus
        />
      ) : (
        <>
          {translationEnabled && translationMatches ? (
            <div className="workflow-reading-toolbar-next" role="group" aria-label="文案阅读模式">
              <button className={viewMode === "original" ? "active" : ""} type="button" onClick={() => setViewMode("original")}>原文</button>
              <button className={viewMode === "translation" ? "active" : ""} type="button" onClick={() => setViewMode("translation")}>{targetLabel}</button>
              <button className={viewMode === "bilingual" ? "active" : ""} type="button" onClick={() => setViewMode("bilingual")}>双语对照</button>
            </div>
          ) : null}
          {viewMode === "translation" && translationMatches ? (
            <div className="workflow-reading-pane-next">
              <strong>{targetLabel}理解对照</strong>
              <pre className="workflow-run-pre-next workflow-translation-output-next workflow-text-result-output-next">{summary.optimizedScript}</pre>
            </div>
          ) : viewMode === "bilingual" && translationMatches ? (
            <div className="workflow-translate-grid-next workflow-reading-grid-next">
              <div className="workflow-reading-pane-next">
                <strong>{sourceLabel}原文</strong>
                <pre className="workflow-run-pre-next workflow-script-output-next workflow-text-result-output-next">{summary.script}</pre>
              </div>
              <div className="workflow-reading-pane-next">
                <strong>{targetLabel}理解对照</strong>
                <pre className="workflow-run-pre-next workflow-translation-output-next workflow-text-result-output-next">{summary.optimizedScript}</pre>
              </div>
            </div>
          ) : (
            <pre className="workflow-run-pre-next workflow-script-output-next workflow-text-result-output-next">{summary.script}</pre>
          )}
          {translationEnabled ? <p className="workflow-translation-note-next">翻译仅供理解，不参与音频、分镜或视频生成。</p> : null}
          {translationRunning ? (
            <div className="workflow-translation-empty-next active">
              <span className="workflow-refresh-spinner-next" aria-hidden="true"></span>
              正在生成{targetLabel}理解对照，原文案和工作流不会受影响。
            </div>
          ) : translationError ? (
            <div className="workflow-translation-empty-next error">{translationError}</div>
          ) : null}
        </>
      )}
      {saveError ? <p className="workflow-run-danger-text-next">{saveError}</p> : null}
    </section>
  );
}

function OptimizationResultSection({ run, workflow, summary, savingScript, checkingCompliance, optimizingScript, onCheckCompliance, onOptimizeScript, onSaveOptimizationScript, onActivateOptimizationVersion }) {
  const [customPrompt, setCustomPrompt] = useState("");
  const [selectedRiskId, setSelectedRiskId] = useState("");
  const [previewVersionId, setPreviewVersionId] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(summary.script || "");
  const [saveError, setSaveError] = useState("");
  const versions = workflowOptimizationVersions(run, summary.script);
  const activeVersion = workflowActiveOptimizationVersion(run, versions, summary.script);
  const viewedVersion = versions.find((version) => version.id === previewVersionId) || activeVersion;
  const viewedScript = viewedVersion.content || summary.script;
  const previewingVersion = viewedVersion.id !== activeVersion.id;
  const report = workflowCurrentComplianceReport(run, viewedVersion, viewedScript);
  const issues = Array.isArray(report?.issues) ? report.issues : [];
  const redCount = issues.filter((issue) => issue.level === "red").length;
  const yellowCount = issues.filter((issue) => issue.level === "yellow").length;
  const highlighted = buildWorkflowComplianceHighlights(viewedScript, issues);

  useEffect(() => {
    setSelectedRiskId("");
  }, [viewedVersion.id, report?.checkedAt]);

  useEffect(() => {
    setPreviewVersionId("");
  }, [activeVersion.id]);

  useEffect(() => {
    setDraft(summary.script || "");
    setEditing(false);
    setSaveError("");
    setCustomPrompt("");
  }, [activeVersion.id, summary.script]);

  if (!summary.script) {
    return (
      <section className="workflow-run-section-card-next error">
        <h4>暂无可优化文案</h4>
        <p>请先完成文案节点，再进入优化节点。</p>
      </section>
    );
  }
  const canRunModel = Boolean(summary.script && !workflowRunHasLiveJob(run));

  function focusRisk(issueId) {
    setSelectedRiskId(issueId);
    if (typeof document === "undefined") return;
    window.requestAnimationFrame(() => document.querySelector(`[data-workflow-risk-ids~="${issueId}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
  }

  async function submitOptimization(event) {
    event.preventDefault();
    if (!customPrompt.trim()) return;
    onOptimizeScript(customPrompt);
  }

  async function saveManualEdit() {
    const content = draft.trim();
    if (!content || content === summary.script || savingScript) return;
    setSaveError("");
    try {
      const completed = await onSaveOptimizationScript(content);
      if (completed) setEditing(false);
    } catch (error) {
      setSaveError(error.message || "文案版本保存失败。");
    }
  }

  return (
    <div className="workflow-optimization-layout-next">
      <section className="workflow-run-section-card-next workflow-compliance-copy-next">
        <div className="workflow-run-section-title-next compact">
          <div>
            <h4>{previewingVersion ? `正在查看 · V${viewedVersion.number}` : `当前文案 · V${activeVersion.number}`}</h4>
            <p>{previewingVersion ? `工作流当前版本为 V${activeVersion.number}；本次查看不会影响已生成的分镜、图片或视频。` : "行内标记与右侧风险清单联动；历史版本不会被覆盖。"}</p>
          </div>
          <div className={`workflow-run-title-actions-next ${previewingVersion ? "workflow-version-preview-actions-next" : ""}`}>
            <span>{countWorkflowChars(viewedScript)} 字</span>
            {previewingVersion ? (
              <>
                <button className="secondary-action compact" type="button" onClick={() => setPreviewVersionId("")}>返回当前版本</button>
                <button className="primary-action compact" type="button" disabled={optimizingScript || workflowRunHasLiveJob(run)} onClick={() => onActivateOptimizationVersion(viewedVersion)}>设为当前</button>
              </>
            ) : editing ? (
              <>
                <button className="secondary-action compact" type="button" disabled={savingScript} onClick={() => { setEditing(false); setDraft(summary.script); setSaveError(""); }}>取消编辑</button>
                <button className="primary-action compact" type="button" disabled={savingScript || !draft.trim() || draft.trim() === summary.script} onClick={saveManualEdit}>{savingScript ? "保存中" : "保存为新版本"}</button>
              </>
            ) : (
              <button className="secondary-action compact" type="button" disabled={checkingCompliance || optimizingScript || workflowRunHasLiveJob(run)} onClick={() => setEditing(true)}>手动修改</button>
            )}
            {!previewingVersion ? (
              <button className="secondary-action compact workflow-compliance-action-next" type="button" disabled={!canRunModel || checkingCompliance || optimizingScript || editing} onClick={onCheckCompliance}>
                {checkingCompliance ? "检测中" : "违规风险检测"}
              </button>
            ) : null}
          </div>
        </div>
        {report ? (
          <div className={`workflow-compliance-summary-next ${report.status || "clear"}`}>
            <strong>{redCount ? `红灯 · ${redCount} 项` : yellowCount ? `黄灯 · ${yellowCount} 项` : "未发现明显风险"}</strong>
            <span>{redCount ? `另有 ${yellowCount} 项黄灯风险` : yellowCount ? "建议处理后再进入发布环节" : "AI 检测仅供辅助，不代表平台审核或法律结论"}</span>
          </div>
        ) : null}
        {editing ? (
          <textarea className="workflow-script-editor-next workflow-optimization-editor-next" value={draft} onChange={(event) => setDraft(event.target.value)} />
        ) : <div className="workflow-run-pre-next workflow-script-output-next workflow-text-result-output-next workflow-compliance-text-next">
          {highlighted.map((segment, index) => segment.level ? (
            <mark
              className={`${segment.level} ${segment.issues.some((issue) => issue.id === selectedRiskId) ? "active" : ""}`}
              data-workflow-risk-ids={segment.issues.map((issue) => issue.id).join(" ")}
              key={`${segment.start}-${segment.end}`}
              onClick={() => setSelectedRiskId(segment.issues[0]?.id || "")}
              title={segment.issues.map((issue) => `${issue.level === "red" ? "红灯" : "黄灯"}：${issue.category}`).join("；")}
            >{segment.text}</mark>
          ) : <span key={`${segment.start}-${segment.end}-${index}`}>{segment.text}</span>)}
        </div>}
        {saveError ? <p className="workflow-run-danger-text-next">{saveError}</p> : null}
      </section>

      <aside className="workflow-optimization-side-next">
        <section className="workflow-run-section-card-next">
          <div className="workflow-run-section-title-next compact">
            <div>
              <h4>违规风险报告</h4>
              <p>点击风险可定位到左侧原文。</p>
            </div>
          </div>
          {checkingCompliance ? (
            <div className="workflow-translation-empty-next active"><span className="workflow-refresh-spinner-next" aria-hidden="true"></span>模型正在逐项检测。</div>
          ) : issues.length ? (
            <div className="workflow-risk-list-next">
              {issues.map((issue) => (
                <button className={`${issue.level} ${selectedRiskId === issue.id ? "active" : ""}`} type="button" key={issue.id} onClick={() => focusRisk(issue.id)}>
                  <span>{issue.level === "red" ? "红灯" : "黄灯"}</span>
                  <strong>{issue.category}</strong>
                  <q>{issue.quote}</q>
                  <small>{issue.reason}</small>
                  {issue.suggestion ? <em>建议：{issue.suggestion}</em> : null}
                </button>
              ))}
            </div>
          ) : report ? (
            <div className="workflow-translation-empty-next">本次检测未发现明显违规风险。</div>
          ) : (
            <div className="workflow-translation-empty-next">点击“违规风险检测”后，这里会显示红灯和黄灯风险。</div>
          )}
        </section>

        <section className="workflow-run-section-card-next">
          <div className="workflow-run-section-title-next compact">
            <div>
              <h4>自定义优化</h4>
              <p>{previewingVersion ? `自定义优化基于当前版本 V${activeVersion.number}；返回当前版本后可继续生成。` : "每次优化都会生成并保留一个新版本。"}</p>
            </div>
          </div>
          <form className="workflow-optimization-form-next" onSubmit={submitOptimization}>
            <textarea value={customPrompt} disabled={previewingVersion} onChange={(event) => setCustomPrompt(event.target.value)} placeholder="例如：弱化血腥描写，保留剧情冲突；让带货表达更自然，删除绝对化承诺。" />
            <button className="primary-action compact" type="submit" disabled={previewingVersion || !canRunModel || optimizingScript || checkingCompliance || !customPrompt.trim()}>
              {optimizingScript ? "正在生成新版本" : `生成 V${Math.max(0, ...versions.map((version) => Number(version.number) || 0)) + 1}`}
            </button>
          </form>
        </section>

        <section className="workflow-run-section-card-next">
        <div className="workflow-run-section-title-next compact">
          <div>
              <h4>版本历史</h4>
              <p>查看版本不会影响后续结果；设为当前后，后续节点结果将被清空。</p>
          </div>
        </div>
          <div className="workflow-version-list-next">
            {[...versions].reverse().map((version) => (
              <div className={`${version.id === activeVersion.id ? "active" : ""} ${version.id === viewedVersion.id ? "viewing" : ""}`} key={version.id}>
                <span>V{version.number}</span>
                <p>{version.prompt || (Number(version.number) === 1 ? "初始生成文案" : "文案版本")}</p>
                <div className="workflow-version-actions-next">
                  {version.id === activeVersion.id ? <strong>当前版本</strong> : null}
                  {version.id !== viewedVersion.id ? <button className="secondary-action compact" type="button" onClick={() => setPreviewVersionId(version.id)}>查看</button> : version.id !== activeVersion.id ? <strong>查看中</strong> : null}
                  {version.id !== activeVersion.id ? <button className="secondary-action compact" type="button" disabled={optimizingScript || workflowRunHasLiveJob(run)} onClick={() => onActivateOptimizationVersion(version)}>设为当前</button> : null}
                </div>
              </div>
            ))}
          </div>
        </section>
      </aside>
    </div>
  );
}

function AudioResultSection({ run, workflow, summary, canQueueAudio, savingAudio, queueingAudio, onSaveAudio, onQueueAudio, onDeleteAudio, onUpdateAudioSrt }) {
  const [uploadPhase, setUploadPhase] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [editingSrtTrackId, setEditingSrtTrackId] = useState("");
  const [srtDraft, setSrtDraft] = useState("");
  const [srtEditError, setSrtEditError] = useState("");

  const audioRunning = workflowNodeIsRunning(run, "audio");
  const audioProgress = workflowAudioProgressView(run.audioProgress);
  const talkingVideo = isTalkingVideoWorkflow(workflow);
  const audioError = run.audioError || (run.stages?.audio === "error" ? run.error : "");
  const audioTracks = Array.isArray(summary.audioTracks) ? summary.audioTracks : [];
  const audioScriptChoices = workflowAudioScriptChoices(summary, workflow);
  const timelineScript = audioScriptChoices.find((choice) => choice.script)?.script || workflowFinalScriptText(summary);
  const audioTrackCount = audioTracks.length;
  const audioPartCount = audioTracks.reduce((sum, track) => sum + Math.max(1, track.parts?.length || 0), 0);
  const expectedSubtitleCount = workflowAudioExpectedSubtitleCount(run, summary);
  const uploadingAudio = Boolean(uploadPhase);
  const uploadLabel = uploadPhase === "transcribing" ? "解析中" : uploadPhase === "uploading" ? "上传中" : "上传音频";

  async function handleUploadAudio(files) {
    const file = Array.from(files || []).find((item) => item.type.startsWith("audio/"));
    if (!file || uploadingAudio || !timelineScript) return;
    setUploadError("");
    setUploadPhase("uploading");
    try {
      const dataUrlPromise = readWorkflowAudioFileDataUrl(file);
      const result = await uploadAssetFiles([file]);
      const uploaded = Array.isArray(result.files) ? result.files[0] : null;
      const uploadedUrl = resolveFlowStudioFileUrl(uploaded?.url || uploaded?.fileUrl || "");
      if (!uploadedUrl) throw new Error("音频上传成功，但没有返回可用 URL。");
      setUploadPhase("transcribing");
      await onSaveAudio({
        audioUrl: uploadedUrl,
        audioDataUrl: await dataUrlPromise,
        duration: summary.audioDuration || "",
        name: file.name,
        language: workflow?.language || "",
        script: timelineScript,
      });
    } catch (error) {
      setUploadError(friendlyWorkflowAudioUploadError(error));
    } finally {
      setUploadPhase("");
    }
  }

  function startEditSrt(track) {
    setEditingSrtTrackId(track.id);
    setSrtDraft(track.subtitle_srt || workflowSegmentsToSrt(track.segments || []));
    setSrtEditError("");
  }

  function cancelEditSrt() {
    setEditingSrtTrackId("");
    setSrtDraft("");
    setSrtEditError("");
  }

  async function saveSrt(track) {
    setSrtEditError("");
    try {
      await onUpdateAudioSrt(track.id, srtDraft);
      cancelEditSrt();
    } catch (error) {
      setSrtEditError(error.message || "SRT 保存失败。");
    }
  }

  return (
    <section className="workflow-run-section-card-next">
      <div className="workflow-run-section-title-next compact">
        <div>
          <h4>口播音频</h4>
          <p>{audioTrackCount ? talkingVideo ? `已保存 ${audioTrackCount} 条音频及 ASR 原始时间轴；最终 SRT 会在分镜切分后生成。` : `已保存 ${audioTrackCount} 条音频、${audioPartCount} 个音频段，可作为后续剪辑基准。` : "根据原文案生成音频，或上传自己录好的口播。"}</p>
        </div>
        <div className="workflow-run-title-actions-next">
          <span>{audioTrackCount ? `${audioTrackCount} 条音频` : "暂无时长"}</span>
        </div>
      </div>
      {audioRunning ? (
        <div className="workflow-run-pending-inline-next">
          <span className="workflow-refresh-spinner-next" aria-hidden="true"></span>
          <div className="workflow-audio-generation-status-next" aria-live="polite">
            <div className="workflow-audio-generation-head-next">
              <h4>{audioProgress.title}</h4>
              {audioProgress.determinate ? <strong>{audioProgress.percentage}%</strong> : null}
            </div>
            <p className="workflow-run-card-copy-next">{audioProgress.determinate ? audioProgress.detail : talkingVideo ? "后台正在生成口播音频并提取 ASR 原始时间戳；最终 SRT 将在分镜切分后生成。" : "后台正在生成口播音频、句子时间戳和 SRT。"}</p>
            {audioProgress.determinate ? (
              <div
                className="workflow-audio-generation-progress-next"
                role="progressbar"
                aria-label={`音频生成进度：已完成 ${audioProgress.completedChunks}/${audioProgress.totalChunks} 段`}
                aria-valuemin="0"
                aria-valuemax="100"
                aria-valuenow={audioProgress.percentage}
              >
                <span style={{ width: `${audioProgress.percentage}%` }} />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      {audioError ? <p className="workflow-run-danger-text-next">{audioError}</p> : null}
      <div className="workflow-audio-actions-next">
        {audioScriptChoices.map((choice) => (
          <button className="secondary-action compact" type="button" key={choice.variant} disabled={!choice.available || !canQueueAudio} onClick={() => onQueueAudio({ audioVariants: [choice.variant] })}>
            {queueingAudio ? "生成中" : audioRunning ? `重新${choice.label}` : choice.label}
          </button>
        ))}
        <label className="secondary-action compact workflow-audio-upload-next">
          {uploadLabel}
          <input
            type="file"
            accept="audio/*"
            disabled={uploadingAudio || savingAudio || !timelineScript}
            onChange={async (event) => {
              await handleUploadAudio(event.target.files);
              event.target.value = "";
            }}
          />
        </label>
      </div>
      {uploadPhase === "transcribing" ? (
        <div className="workflow-run-pending-inline-next workflow-audio-upload-status-next">
          <span className="workflow-refresh-spinner-next" aria-hidden="true"></span>
          <div>
            <h4>上传音频解析中</h4>
            <p className="workflow-run-card-copy-next">{talkingVideo ? "音频服务 正在识别本地录音并提取 ASR 原始时间戳。" : "音频服务 正在识别本地录音，并生成时间戳和 SRT。"}</p>
          </div>
        </div>
      ) : null}
      {uploadError ? <p className="workflow-run-danger-text-next">{uploadError}</p> : null}
      <div className="workflow-audio-source-note-next">
        {audioScriptChoices.map((choice) => (
          <span key={choice.variant}>{workflowCopyLanguageLabel(choice.variant)}文案：{choice.script ? `${choice.count} 字` : choice.emptyText}</span>
        ))}
      </div>
      {audioTracks.length ? (
        <div className="workflow-audio-track-list-next">
          {audioTracks.map((track) => (
            <article className="workflow-audio-track-next" key={track.id}>
              {(() => {
                const subtitleCountWarning = workflowAudioTrackSubtitleCountWarning(track, run, summary);
                const isEditingSrt = editingSrtTrackId === track.id;
                return (
                  <>
              <div className="workflow-audio-track-head-next">
                <div>
                  <h5>{track.label || workflowAudioTrackLabel(track.variant)}</h5>
                  <p>
                    {track.source === "upload" ? "用户上传" : "生成音频"}
                    {" · "}
                    {Math.max(1, track.parts?.length || 0)} 段
                    {" · "}
                    {formatWorkflowDuration(track.duration)}
                  </p>
                </div>
                <div className="workflow-audio-track-actions-next">
                  {track.subtitle_srt ? (
                    <>
                      <CopyButton text={track.subtitle_srt} label="复制 SRT" />
                      <button className="secondary-action compact" type="button" disabled={savingAudio || queueingAudio} onClick={() => startEditSrt(track)}>
                        编辑 SRT
                      </button>
                    </>
                  ) : null}
                  <button className="secondary-action compact danger-soft-next" type="button" disabled={savingAudio || queueingAudio} onClick={() => onDeleteAudio(track.id)}>
                    删除
                  </button>
                </div>
              </div>
              {talkingVideo && track.subtitleStatus === "pending" ? (
                <p className="workflow-audio-count-hint-next">原始时间轴已就绪。请选择智能时长或标点模式生成分镜，系统会同时生成最终 SRT 和镜头音频时间轴。</p>
              ) : null}
              {expectedSubtitleCount ? (
                <p className="workflow-audio-count-hint-next">分镜图片 {expectedSubtitleCount} 张，当前 SRT {track.segments?.length || 0} 条。</p>
              ) : null}
              {workflowAudioAlignmentWarning(track) ? (
                <p className="workflow-run-danger-text-next">{workflowAudioAlignmentWarning(track)}</p>
              ) : null}
              {subtitleCountWarning ? (
                <p className="workflow-run-danger-text-next">{subtitleCountWarning}</p>
              ) : null}
              <div className="workflow-audio-part-list-next">
                {(track.parts?.length ? track.parts : [track]).map((part, index) => (
                  <div className="workflow-audio-part-next" key={`${track.id}-${part.id || part.audio_url || index}`}>
                    <div className="workflow-audio-part-meta-next">
                      <strong>{part.name || `第 ${Number(part.index || index + 1)} 段`}</strong>
                      <span>{formatWorkflowDuration(part.duration || track.duration)}</span>
                    </div>
                    {part.audio_url ? <audio src={part.audio_url} controls /> : null}
                    {part.audio_url ? (
                      <a className="secondary-action compact" href={part.audio_url} target="_blank" rel="noreferrer">打开音频</a>
                    ) : null}
                  </div>
                ))}
              </div>
              {track.subtitle_srt ? (
                <details className="workflow-audio-srt-next" open={isEditingSrt ? true : undefined}>
                  <summary>
                    <span>SRT 字幕</span>
                    <small>{track.segments?.length ? `${track.segments.length} 条字幕，点击展开/收起` : "点击展开/收起"}</small>
                  </summary>
                  {isEditingSrt ? (
                    <div className="workflow-audio-srt-editor-next">
                      <textarea
                        className="workflow-script-editor-next workflow-audio-srt-textarea-next"
                        value={srtDraft}
                        onChange={(event) => setSrtDraft(event.target.value)}
                        rows={12}
                        autoFocus
                      />
                      {srtEditError ? <p className="workflow-run-danger-text-next">{srtEditError}</p> : null}
                      <div className="workflow-audio-srt-actions-next">
                        <button className="secondary-action compact" type="button" disabled={savingAudio} onClick={cancelEditSrt}>取消</button>
                        <button className="primary-action compact" type="button" disabled={savingAudio} onClick={() => saveSrt(track)}>
                          {savingAudio ? "保存中" : "保存 SRT"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <pre className="workflow-run-pre-next workflow-shot-output-next">{track.subtitle_srt}</pre>
                  )}
                </details>
              ) : null}
                  </>
                );
              })()}
            </article>
          ))}
        </div>
      ) : null}
      {!audioTracks.length ? (
        <article className="workflow-video-empty-next">
          <span>♪</span>
          <h4>还没有音频时间戳</h4>
          <p>可以根据原文案生成口播音频，也可上传自己录好的音频作为时间轴基准。</p>
        </article>
      ) : null}
    </section>
  );
}

function ShotResultSection({ run, workflow, summary, canEditShot, savingShot, canQueueShot, queueingShot, onSaveShot, onQueueShot, onOpenManualOutfitVariant }) {
  const ecommerce = isStoryboardWorkflow(workflow);
  const talkingVideo = isTalkingVideoWorkflow(workflow);
  const waitingForTalkingVideoAudio = talkingVideo && !workflowStageHasOutput(run, "audio");
  const rawShotText = workflowShotText(run) || summary.shotOutput || "";
  const aiDirectorStoryboard = ecommerce && summary.storyboardMode === "ai-director";
  const visibleShotText = aiDirectorStoryboard
    ? aiDirectorStoryboardTextOnly(rawShotText)
    : ecommerce ? ecommerceShotResultTextOnly(rawShotText, summary.script) : rawShotText;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(visibleShotText);
  const [saveError, setSaveError] = useState("");
  const [assetDialogOpen, setAssetDialogOpen] = useState(false);

  useEffect(() => {
    setDraft(visibleShotText);
    setEditing(false);
    setSaveError("");
  }, [run.id, visibleShotText, summary.shots.length]);

  async function handleSave() {
    const output = draft.trim();
    if (!output || savingShot) return;
    setSaveError("");
    try {
      await onSaveShot(output);
      setEditing(false);
    } catch (error) {
      setSaveError(error.message || "分镜保存失败。");
    }
  }

  if (run.stages?.shot === "running") {
    return (
      <section className="workflow-run-section-card-next">
        <div className="workflow-run-pending-inline-next">
          <span className="workflow-refresh-spinner-next" aria-hidden="true"></span>
          <div>
            <h4>分镜生成中</h4>
            <p className="workflow-run-card-copy-next">正在根据确认好的文案拆解画面镜头，完成后会自动同步到这里。</p>
          </div>
        </div>
      </section>
    );
  }
  if (run.stages?.shot === "error") {
    return (
      <section className="workflow-run-section-card-next error">
        <div className="workflow-run-section-title-next compact">
          <div>
            <h4>分镜生成失败</h4>
            <p>{run.shotError || "当前分镜节点没有生成成功。"}</p>
          </div>
          <button className="secondary-action compact" type="button" disabled={!canQueueShot} onClick={onQueueShot}>
            重新生成分镜
          </button>
        </div>
      </section>
    );
  }
  const parsedShots = workflowParsedShotOutput(run);
  const shotCount = summary.shots.length || parsedShots.length;
  if (!shotCount && !summary.shotOutput) {
    return (
      <section className="workflow-run-empty-card-next">
        <h4>还没有分镜</h4>
        <p>{summary.script ? waitingForTalkingVideoAudio ? "请先完成音频节点，再生成分镜和图片。" : "基于当前文案生成分镜后，这里会显示镜头拆解和图片提示词。" : "请先完成文案节点，再生成分镜。"}</p>
        <button className="primary-action compact" type="button" disabled={!canQueueShot} onClick={onQueueShot}>
          {queueingShot ? "提交中" : "生成分镜"}
        </button>
      </section>
    );
  }

  const shotText = visibleShotText;
  const assetReferenceModel = ecommerce ? workflowShotAssetReferenceModel(run, summary, rawShotText) : null;
  const hasAssetReferences = Boolean(assetReferenceModel?.rows?.length || assetReferenceModel?.assets?.length);
  const outfitSummary = ecommerce ? workflowRoleOutfitVariantSummary(summary) : null;

  return (
    <section className="workflow-run-section-card-next">
      <div className="workflow-run-section-title-next compact">
        <div>
          <h4>{aiDirectorStoryboard ? "AI 导演分镜" : ecommerce ? "角色与场景映射" : "分镜提示词"}</h4>
          <p>{editing ? "正在编辑分镜，保存后会重新解析。" : aiDirectorStoryboard ? `已按完整剧本生成 ${summary.aiDirectorPlan.segments?.length || 0} 条视频任务；角色图与场景图完成后可直接组装最终提示词。` : ecommerce ? "已生成角色映射和场景映射，后续会据此生成角色图和场景图。" : shotCount ? `已生成 ${shotCount} 个镜头，可作为后续图片生成的画面提示词。` : "已读取分镜文本结果。"}</p>
          {outfitSummary ? <WorkflowRoleOutfitStatus summary={outfitSummary} /> : null}
        </div>
        <div className="workflow-run-title-actions-next">
          <span>{aiDirectorStoryboard ? `最大 ${summary.aiDirectorMaxDurationSeconds || 15} 秒` : ecommerce ? "映射结果" : shotCount ? `${shotCount} 个镜头` : "文本结果"}</span>
          {editing ? (
            <>
              <button className="secondary-action compact" type="button" disabled={savingShot} onClick={() => { setEditing(false); setDraft(shotText); }}>
                取消
              </button>
              <button className="primary-action compact" type="button" disabled={savingShot || !draft.trim()} onClick={handleSave}>
                {savingShot ? "保存中" : "保存分镜"}
              </button>
            </>
          ) : (
            <>
              {ecommerce ? (
                <button className="secondary-action compact" type="button" disabled={!hasAssetReferences} onClick={() => setAssetDialogOpen(true)}>
                  资产引用
                </button>
              ) : null}
              {ecommerce ? (
                <button className="secondary-action compact" type="button" disabled={!canEditShot} onClick={() => onOpenManualOutfitVariant?.()}>
                  添加变装版本
                </button>
              ) : null}
              {!aiDirectorStoryboard ? (
                <button className="secondary-action compact" type="button" disabled={!canEditShot} onClick={() => setEditing(true)}>
                  编辑分镜
                </button>
              ) : null}
              <CopyButton text={shotText} label="复制" />
            </>
          )}
        </div>
      </div>
      {editing ? (
        <textarea
          className="workflow-script-editor-next workflow-shot-editor-next"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={18}
          autoFocus
        />
      ) : (
        <pre className="workflow-run-pre-next workflow-shot-output-next workflow-text-result-output-next">{shotText}</pre>
      )}
      {talkingVideo && summary.audioSegments.length && summary.subtitleSrt ? (
        <TalkingShotTimingResult
          mode={run.talkingShotSegmentationMode}
          segments={summary.audioSegments}
          subtitleSrt={summary.subtitleSrt}
        />
      ) : null}
      {saveError ? <p className="workflow-run-danger-text-next">{saveError}</p> : null}
      {assetDialogOpen ? (
        <ShotAssetReferenceDialog
          model={assetReferenceModel}
          onClose={() => setAssetDialogOpen(false)}
        />
      ) : null}
    </section>
  );
}

function TalkingShotTimingResult({ mode = "", segments = [], subtitleSrt = "" }) {
  const modeLabel = mode === "punctuation" ? "按标点切分" : "智能时长切分";
  return (
    <section className="workflow-talking-timing-result-next">
      <div className="workflow-talking-timing-head-next">
        <div>
          <h5>最终字幕与音频时间轴</h5>
          <p>以下结果与当前分镜一一对应，可直接用于字幕和后续剪辑。</p>
        </div>
        <span>{modeLabel} · {segments.length} 段</span>
      </div>
      <div className="workflow-talking-timing-grid-next">
        <article className="workflow-talking-srt-card-next">
          <div>
            <strong>最终 SRT</strong>
            <CopyButton text={subtitleSrt} label="复制 SRT" />
          </div>
          <pre>{subtitleSrt}</pre>
        </article>
        <article className="workflow-talking-timeline-card-next">
          <div>
            <strong>音频时间轴</strong>
            <span>镜头 / 起止时间 / 字幕</span>
          </div>
          <ol>
            {segments.map((segment, index) => (
              <li key={`${segment.index || index + 1}-${segment.start}-${segment.end}`}>
                <span className="workflow-talking-timeline-index-next">{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <strong>{formatWorkflowTimelineRange(segment.start, segment.end)}</strong>
                  <small>{formatWorkflowDuration(Math.max(0, Number(segment.end || 0) - Number(segment.start || 0)))}</small>
                  <p>{segment.text}</p>
                </div>
              </li>
            ))}
          </ol>
        </article>
      </div>
    </section>
  );
}

function WorkflowRoleOutfitStatus({ summary }) {
  const message = workflowRoleOutfitVariantMessage(summary);
  if (!message) return null;
  const titles = Array.isArray(summary.variantTitles) ? summary.variantTitles.filter(Boolean).slice(0, 4) : [];
  const remainingCount = Math.max((Number(summary.variantCount) || titles.length) - titles.length, 0);
  return (
    <div className={`workflow-outfit-status-next ${workflowOutfitVariantTone(summary.status)}`} role="status">
      <strong>{message}</strong>
      {titles.length ? (
        <small>
          新增资产：{titles.join("、")}{remainingCount ? ` 等 ${remainingCount + titles.length} 个` : ""}
        </small>
      ) : null}
    </div>
  );
}

function ShotAssetReferenceDialog({ model, onClose }) {
  const [activeTab, setActiveTab] = useState("shots");
  const rows = Array.isArray(model?.rows) ? model.rows : [];
  const assets = Array.isArray(model?.assets) ? model.assets : [];
  const rawJson = JSON.stringify(model?.raw || {}, null, 2);
  const tabOptions = [
    { id: "shots", label: "逐镜引用" },
    { id: "assets", label: "资产清单" },
    { id: "json", label: "原始 JSON" },
  ];
  return (
    <WorkflowDialogPortal>
      <div className="workflow-image-dialog-backdrop-next" role="presentation" onClick={onClose}>
        <section className="workflow-image-retry-dialog-next workflow-shot-asset-dialog-next" role="dialog" aria-modal="true" aria-label="逐镜资产引用" onClick={(event) => event.stopPropagation()}>
          <div className="workflow-shot-asset-dialog-head-next">
            <div>
              <h4>逐镜资产引用（高级）</h4>
              <p>用于视频提示词 @图片 匹配，普通编辑无需处理。</p>
            </div>
            <button className="secondary-action compact" type="button" onClick={onClose}>关闭</button>
          </div>
          <div className="workflow-shot-asset-tabs-next" role="tablist" aria-label="逐镜资产引用视图">
            {tabOptions.map((tab) => (
              <button className={activeTab === tab.id ? "selected" : ""} type="button" role="tab" aria-selected={activeTab === tab.id} onClick={() => setActiveTab(tab.id)} key={tab.id}>
                {tab.label}
              </button>
            ))}
          </div>
          {activeTab === "shots" ? (
            rows.length ? (
              <div className="workflow-shot-asset-table-wrap-next">
                <table className="workflow-shot-asset-table-next">
                  <thead>
                    <tr>
                      <th>镜头</th>
                      <th>场景图</th>
                      <th>角色图</th>
                      <th>产品图</th>
                      <th>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.shotIndex}>
                        <td>第 {row.shotIndex} 镜</td>
                        <td>{workflowAssetRefCells(row.scenes)}</td>
                        <td>{workflowAssetRefCells(row.roles)}</td>
                        <td>{workflowAssetRefCells(row.products)}</td>
                        <td><span className={`workflow-shot-asset-status-next ${row.statusTone}`}>{row.status}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="workflow-shot-asset-empty-next">暂无逐镜资产引用。</p>
            )
          ) : null}
          {activeTab === "assets" ? (
            assets.length ? (
              <div className="workflow-shot-asset-list-next">
                {["scene", "role", "product"].map((type) => {
                  const items = assets.filter((asset) => asset.assetType === type);
                  if (!items.length) return null;
                  return (
                    <div className="workflow-shot-asset-group-next" key={type}>
                      <h5>{type === "scene" ? "场景资产" : type === "role" ? "角色资产" : "产品资产"}</h5>
                      {items.map((asset) => (
                        <article key={`${asset.assetType}-${asset.assetRef || asset.title}`}>
                          <strong>{[asset.assetRef, asset.title].filter(Boolean).join(" · ")}</strong>
                          <span>{asset.shotRefs.length ? `第 ${asset.shotRefs.join("、")} 镜` : "未绑定镜头"}</span>
                        </article>
                      ))}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="workflow-shot-asset-empty-next">暂无资产清单。</p>
            )
          ) : null}
          {activeTab === "json" ? (
            <pre className="workflow-shot-asset-json-next">{rawJson}</pre>
          ) : null}
        </section>
      </div>
    </WorkflowDialogPortal>
  );
}

function workflowAssetRefCells(items = []) {
  if (!items.length) return <span className="workflow-shot-asset-muted-next">无</span>;
  return (
    <div className="workflow-shot-asset-cell-list-next">
      {items.map((item) => (
        <span key={`${item.ref}-${item.title}`}>
          {item.ref ? <b>{item.ref}</b> : null}
          {item.title ? <em>{item.title}</em> : null}
        </span>
      ))}
    </div>
  );
}
function ImageResultSection({ run, workflow, summary, selectionActive, selectedImageIds, downloadingImages, watermarkingRoleImageIds = [], restoringRoleImageIds = [], imagePackageJob, savingImagePromptId, uploadingProductImageId, uploadingRoleImageId, onToggleSelection, onToggleShot, onPreviewImage, onRegenerateImage, onOpenManualOutfitVariant, onSaveImagePrompt, onUploadProductImage, onUploadRoleImage, onOpenRoleWatermarkDialog, onRemoveRoleNameWatermark, onDeleteImage, onDeleteSelectedImages, onDownloadSelectedImages, onDeleteImagePackage }) {
  const shots = summary.shots;
  const ecommerce = isStoryboardWorkflow(workflow);
  const commercialStory = isEcommerceWorkflow(workflow);
  if (!shots.length) {
    return (
      <section className="workflow-run-empty-card-next">
        <h4>{ecommerce ? commercialStory ? "还没有角色图、场景图和商品图" : "还没有角色图和场景图" : "还没有分镜图片"}</h4>
        <p>{ecommerce ? commercialStory ? "分镜结果生成后，这里会展示角色资产、场景资产和商品资产。" : "分镜结果生成后，这里会展示角色资产和场景资产。" : "分镜完成后，这里会按镜头展示图片生成结果。"}</p>
      </section>
    );
  }
  const generatedCount = summary.imageShots.length;
  const missingCount = shots.length - generatedCount;
  const allSelected = selectionActive && generatedCount > 0 && selectedImageIds.length === generatedCount;
  const roleShots = ecommerce ? shots.filter((shot) => shot.assetType === "role") : [];
  const sceneShots = ecommerce ? shots.filter((shot) => shot.assetType === "scene") : [];
  const productShots = commercialStory ? shots.filter((shot) => shot.assetType === "product") : [];
  const roleImageShots = roleShots.filter((shot) => workflowShotImageUrl(shot));
  const sceneImageShots = sceneShots.filter((shot) => workflowShotImageUrl(shot));
  const restorableRoleImageShots = roleImageShots.filter(workflowRoleNameWatermarkRestorable);
  const restorableSceneImageShots = sceneImageShots.filter(workflowRoleNameWatermarkRestorable);
  const watermarkingSet = new Set(watermarkingRoleImageIds);
  const restoringSet = new Set(restoringRoleImageIds);
  const watermarkingRoles = watermarkingSet.size > 0;
  const restoringRoles = restoringSet.size > 0;
  const watermarkBusy = watermarkingRoles || restoringRoles;

  const renderShotCards = (items) => items.map((shot, index) => (
    <ShotImageCard
      shot={shot}
      run={run}
      index={shots.indexOf(shot) >= 0 ? shots.indexOf(shot) : index}
      selectionActive={selectionActive}
      selected={selectedImageIds.includes(workflowShotId(shot))}
      onToggleShot={onToggleShot}
      onPreviewImage={onPreviewImage}
      onRegenerateImage={onRegenerateImage}
      onOpenManualOutfitVariant={onOpenManualOutfitVariant}
      onSaveImagePrompt={onSaveImagePrompt}
      onUploadProductImage={onUploadProductImage}
      onUploadRoleImage={onUploadRoleImage}
      onOpenRoleWatermarkDialog={onOpenRoleWatermarkDialog}
      onRemoveRoleNameWatermark={onRemoveRoleNameWatermark}
      savingPrompt={savingImagePromptId === workflowShotId(shot)}
      uploadingProductImage={uploadingProductImageId === workflowShotId(shot)}
      uploadingRoleImage={uploadingRoleImageId === workflowShotId(shot)}
      watermarking={watermarkingSet.has(workflowShotId(shot))}
      restoringWatermark={restoringSet.has(workflowShotId(shot))}
      onDeleteImage={onDeleteImage}
      ecommerce={ecommerce}
      key={shot.id || shot.shotId || workflowShotImageUrl(shot) || index}
    />
  ));

  return (
    <section className="workflow-run-section-card-next">
      <div className="workflow-run-section-title-next compact">
        <div>
          <h4>{ecommerce ? "角色图、场景图与商品图" : "分镜图片结果"}</h4>
          <p>{ecommerce ? `当前共有 ${shots.length} 个角色/场景/商品图片项，已就绪 ${generatedCount} 张${missingCount ? `，缺失 ${missingCount} 张` : ""}。` : `当前共有 ${shots.length} 个镜头，已生成 ${generatedCount} 张${missingCount ? `，缺失 ${missingCount} 张` : ""}。`}</p>
        </div>
        <div className="workflow-run-title-actions-next">
          <span>{generatedCount} 张图片</span>
          {generatedCount ? (
            <button className="secondary-action compact" type="button" onClick={onToggleSelection}>
              {allSelected ? "取消全选" : "全选图片"}
            </button>
          ) : null}
          {selectionActive && generatedCount ? (
            <>
              <button className="secondary-action compact" type="button" disabled={!selectedImageIds.length || downloadingImages} onClick={onDownloadSelectedImages}>
                {downloadingImages ? "打包中..." : `下载（${selectedImageIds.length}）`}
              </button>
              <button className="secondary-action compact danger-soft-next" type="button" disabled={!selectedImageIds.length || downloadingImages} onClick={onDeleteSelectedImages}>
                批量删除（{selectedImageIds.length}）
              </button>
            </>
          ) : null}
        </div>
      </div>
      {imagePackageJob ? (
        <ImagePackageStatusCard
          job={imagePackageJob}
          onDelete={() => onDeleteImagePackage?.(imagePackageJob)}
        />
      ) : null}
      {ecommerce ? (
        <div className="workflow-ecommerce-image-board-next">
          {roleShots.length ? (
            <section className="workflow-ecommerce-image-group-next">
              <div className="workflow-ecommerce-image-group-head-next">
                <div>
                  <b>角色资产</b>
                  <span>按工作流参考图策略复用或生成角色图。</span>
                </div>
                <div className="workflow-ecommerce-image-group-actions-next">
                  <button className="secondary-action compact" type="button" disabled={!roleImageShots.length || watermarkBusy} onClick={() => onOpenRoleWatermarkDialog?.(roleImageShots.map(workflowShotId).filter(Boolean))}>
                    {watermarkingRoles ? "加水印中..." : "增加水印"}
                  </button>
                  {restorableRoleImageShots.length ? (
                    <button className="secondary-action compact" type="button" disabled={watermarkBusy} onClick={() => onRemoveRoleNameWatermark?.(restorableRoleImageShots.map(workflowShotId).filter(Boolean))}>
                      {restoringRoles ? "取消中..." : "取消水印"}
                    </button>
                  ) : null}
                  <strong>{roleShots.length} 个</strong>
                </div>
              </div>
              <div className="workflow-shot-image-grid-next ecommerce-assets role-assets">
                {renderShotCards(roleShots)}
              </div>
            </section>
          ) : null}
          {sceneShots.length ? (
            <section className="workflow-ecommerce-image-group-next">
              <div className="workflow-ecommerce-image-group-head-next">
                <div>
                  <b>场景资产</b>
                  <span>按复用场景生成空镜图，镜头映射默认折叠展示。</span>
                </div>
                <div className="workflow-ecommerce-image-group-actions-next">
                  <button className="secondary-action compact" type="button" disabled={!sceneImageShots.length || watermarkBusy} onClick={() => onOpenRoleWatermarkDialog?.(sceneImageShots.map(workflowShotId).filter(Boolean), "scene")}>
                    {watermarkingRoles ? "加水印中..." : "增加水印"}
                  </button>
                  {restorableSceneImageShots.length ? (
                    <button className="secondary-action compact" type="button" disabled={watermarkBusy} onClick={() => onRemoveRoleNameWatermark?.(restorableSceneImageShots.map(workflowShotId).filter(Boolean))}>
                      {restoringRoles ? "取消中..." : "取消水印"}
                    </button>
                  ) : null}
                  <strong>{sceneShots.length} 个</strong>
                </div>
              </div>
              <div className="workflow-shot-image-grid-next ecommerce-assets scene-assets">
                {renderShotCards(sceneShots)}
              </div>
            </section>
          ) : null}
          {productShots.length ? (
            <section className="workflow-ecommerce-image-group-next">
              <div className="workflow-ecommerce-image-group-head-next">
                <div>
                  <b>商品资产</b>
                  <span>直接复用带货产品库里的商品图。</span>
                </div>
                <strong>{productShots.length} 个</strong>
              </div>
              <div className="workflow-shot-image-grid-next ecommerce-assets product-assets">
                {renderShotCards(productShots)}
              </div>
            </section>
          ) : null}
        </div>
      ) : (
        <div className="workflow-shot-image-grid-next">
          {renderShotCards(shots)}
        </div>
      )}
    </section>
  );
}

function ImagePackageStatusCard({ job, onDelete }) {
  const status = job.status || "running";
  const progress = Math.max(0, Math.min(100, Number(job.progress) || 0));
  const isDone = status === "done" && job.downloadPath;
  const isError = status === "error" || status === "expired";
  return (
    <div className={`workflow-image-package-card-next ${isDone ? "done" : ""} ${isError ? "error" : ""}`}>
      <div className="workflow-image-package-copy-next">
        <strong>{isDone ? "压缩包已准备好" : isError ? "压缩包不可用" : "正在打包图片"}</strong>
        <span>{job.detail || (isDone ? "点击下载按钮后开始保存到本地。" : `已处理 ${job.done || 0}/${job.total || 0} 张图片`)}</span>
        {isDone ? <span>下载链接 {workflowPackageExpiresText(job.expiresAt)}，过期后需要重新打包。</span> : null}
      </div>
      <div className="workflow-image-package-progress-next" aria-label={`打包进度 ${progress}%`}>
        <span style={{ width: `${progress}%` }} />
      </div>
      <div className="workflow-image-package-actions-next">
        {job.fileName ? <code>{job.fileName}</code> : <code>准备生成压缩包...</code>}
        {isDone ? (
          <div className="workflow-image-package-button-row-next">
            <a className="primary-action compact" href={buildImageZipDownloadUrl(job.downloadPath)} download={job.fileName || "分镜图片.zip"}>
              下载 ZIP
            </a>
            <button className="secondary-action compact danger-soft-next" type="button" onClick={onDelete}>
              删除链接
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function VideoTimelineSection({ run, workflow, summary, videoTimelineTask, videoPackageJob, browserVideoPackageJob, packagingVideoMaterials, browserPackagingVideoMaterials, onOpenVideoGrouping, onClearVideoTimeline, onAssembleVideoPrompts, onPackVideoMaterials, onBrowserPackVideoMaterials, onOpenVideoGenerate, onOpenMissingVideoGenerate, generatingVideoSegmentId, editingVideoPromptId, videoPromptDraft, savingVideoPromptId, onStartEditVideoPrompt, onChangeVideoPromptDraft, onCancelEditVideoPrompt, onSaveVideoPrompt, onCopyVideoPrompt, onDeleteVideoTimelineItem, onDeleteVideoTimelineAsset }) {
  const ecommerce = isStoryboardWorkflow(workflow);
  const aiDirectorStoryboard = ecommerce && summary.storyboardMode === "ai-director";
  const missingVideoTargets = workflowVideoMissingTargets(summary.videoTimeline, summary.videoResults);
  const missingVideoCount = missingVideoTargets.length;
  const batchSubmitting = generatingVideoSegmentId === workflowVideoBatchSubmitId;
  const packagingBusy = packagingVideoMaterials || browserPackagingVideoMaterials;
  if (!summary.videoTimeline.length) {
    const imageReady = summary.shots.length > 0 && summary.shots.every((shot) => workflowShotImageUrl(shot));
    const storyboardReady = workflowStoryboardReadyForVideoTimeline({
      workflowType: workflow?.type || workflow?.workflowType || workflow?.config?.type,
      storyboardMode: summary.storyboardMode,
      aiDirectorPlan: summary.aiDirectorPlan,
      traditionalStoryboardCount: ecommerceStoryboardShots(summary.script || summary.shotOutput).length,
    });
    const aiDirectorEmptyHint = !imageReady
      ? "请先完成全部角色图、场景图和商品图。"
      : !storyboardReady
        ? "AI 导演分镜计划缺失，请重新生成 AI 导演分镜。"
        : "点击上方“组装视频提示词”，系统只负责绑定图片编号并追加固定规则，不会再次请求 LLM。";
    return (
      <section className="workflow-run-section-card-next">
        <div className="workflow-run-section-title-next compact">
          <div>
            <h4>视频时间线</h4>
            <p>{aiDirectorStoryboard ? "AI 导演分镜已完成；角色图与场景图完成后可按本地文件名排序绑定图片并组装最终提示词。" : ecommerce ? "时间线为空，角色图与场景图完成后可按分镜脚本分组生成视频片段。" : "时间线为空，分镜图片全部完成后可添加到这里。"}</p>
          </div>
          <div className="workflow-run-title-actions-next workflow-video-toolbar-next">
            <span>0 个片段</span>
            <button className="primary-action compact" type="button" disabled={!imageReady || !storyboardReady} onClick={onOpenVideoGrouping}>
              {aiDirectorStoryboard ? "组装视频提示词" : ecommerce ? "添加到时间线" : "添加"}
            </button>
          </div>
        </div>
        {videoTimelineTask ? <WorkflowVideoTaskCard task={videoTimelineTask} type="timeline" /> : null}
        <article className="workflow-video-empty-next">
          <span>▷</span>
          <h4>时间线为空</h4>
          <p>{aiDirectorStoryboard ? aiDirectorEmptyHint : ecommerce ? imageReady && storyboardReady ? "点击上方“添加到时间线”，选择每组几个镜头后，会聚合组内对应角色图与场景图，并自动去重。" : "请先完成角色图、场景图，并确保文案里有分镜脚本详情。" : imageReady ? "点击上方“添加”，会按分镜顺序把已生成图片同步到视频时间线。" : "请先完成全部分镜图片，再添加到视频制作时间线。"}</p>
        </article>
      </section>
    );
  }
  return (
    <section className="workflow-run-section-card-next">
      <div className="workflow-run-section-title-next compact">
        <div>
          <h4>视频时间线</h4>
          <p>{ecommerce ? `已按分镜脚本分组生成 ${summary.videoTimeline.length} 个视频片段，可继续编辑视频提示词和打包制作资料。` : `已同步 ${summary.videoTimeline.length} 个片段，可继续整理视频提示词和制作资料。`}</p>
        </div>
        <div className="workflow-run-title-actions-next">
          <span>{summary.videoTimeline.length} 个片段</span>
          <button className="secondary-action compact danger-soft-next" type="button" disabled={packagingBusy} onClick={onClearVideoTimeline}>
            清空所有分镜
          </button>
          <button className="secondary-action compact" type="button" disabled={packagingBusy} onClick={onAssembleVideoPrompts}>
            组装视频提示词
          </button>
          <button className="secondary-action compact" type="button" disabled={packagingBusy} onClick={onPackVideoMaterials}>
            {packagingVideoMaterials ? "打包中..." : "打包视频制作资料"}
          </button>
          <button className="primary-action compact" type="button" disabled={packagingBusy || batchSubmitting || !missingVideoCount} onClick={onOpenMissingVideoGenerate}>
            {batchSubmitting ? "提交中..." : `生成缺失视频${missingVideoCount ? `(${missingVideoCount})` : ""}`}
          </button>
        </div>
      </div>
      {videoTimelineTask ? <WorkflowVideoTaskCard task={videoTimelineTask} type="timeline" /> : null}
      {videoPackageJob || summary.videoPackageStatus || summary.videoPackageDetail || summary.videoPackageError ? (
        <WorkflowVideoTaskCard
          task={videoPackageJob || {
            status: summary.videoPackageStatus,
            progress: summary.videoPackageStatus === "done" || summary.videoPackageStatus === "error" ? 100 : 0,
            done: summary.videoPackageDone || 0,
            total: summary.videoPackageTotal || workflowVideoMaterialAssetCount({ videoTimeline: summary.videoTimeline }),
            detail: summary.videoPackageDetail,
            error: summary.videoPackageError,
            fileName: summary.videoPackageName,
            expiresAt: summary.videoPackage?.expiresAt,
            downloadPath: summary.videoPackage?.downloadPath,
          }}
          type="package"
          onBrowserPackage={onBrowserPackVideoMaterials}
          browserPackaging={browserPackagingVideoMaterials}
        />
      ) : null}
      {browserVideoPackageJob ? <WorkflowBrowserPackageCard task={browserVideoPackageJob} /> : null}
      <div className="workflow-video-timeline-next">
        {summary.videoTimeline.map((item, index) => (
          <TimelineSegmentCard
            item={item}
            index={index}
            editing={editingVideoPromptId === workflowTimelineItemId(item, index)}
            draft={videoPromptDraft}
            saving={savingVideoPromptId === workflowTimelineItemId(item, index)}
            generating={batchSubmitting || generatingVideoSegmentId === workflowTimelineItemId(item, index)}
            onEdit={() => onStartEditVideoPrompt(item, index)}
            onGenerate={() => onOpenVideoGenerate?.(item, index)}
            onCopy={() => onCopyVideoPrompt?.(item, index)}
            onDelete={() => onDeleteVideoTimelineItem?.(item, index)}
            onDeleteAsset={(asset, assetIndex) => onDeleteVideoTimelineAsset?.(item, index, asset, assetIndex)}
            onChangeDraft={onChangeVideoPromptDraft}
            onCancel={onCancelEditVideoPrompt}
            onSave={() => onSaveVideoPrompt(item, index)}
            key={item.id || `${item.title || "timeline"}-${index}`}
          />
        ))}
      </div>
    </section>
  );
}

function WorkflowVideoTaskCard({ task, type = "package", onDelete, onBrowserPackage, browserPackaging = false }) {
  if (!task) return null;
  const progress = Math.max(0, Math.min(100, Math.round(Number(task.progress) || 0)));
  const isPackage = type === "package" || type === "resultPackage";
  const isResultPackage = type === "resultPackage";
  const isExpired = isPackage && (task.status === "expired" || workflowPackageIsExpired(task.expiresAt));
  const isError = task.status === "error" || isExpired;
  const isDone = task.status === "done" && !isExpired;
  const isRunning = !isDone && !isError;
  const isIndeterminate = Boolean(task.indeterminate && isRunning);
  const aiDirectorTimeline = type === "timeline" && task.mode === "ai-director";
  const title = type === "timeline"
    ? aiDirectorTimeline
      ? isDone ? "AI 导演视频提示词已组装" : isError ? "AI 导演视频提示词组装失败" : "正在组装 AI 导演视频提示词"
      : isDone ? "视频时间线已添加" : isError ? "视频时间线添加失败" : "正在添加视频时间线"
    : isResultPackage
      ? isExpired ? "视频结果压缩包已失效" : isDone ? "视频结果压缩包已准备好" : isError ? "视频结果压缩包创建失败" : "正在创建视频结果压缩包"
      : isExpired ? "视频制作资料已失效" : isDone ? "视频制作资料已打包" : isError ? "视频制作资料打包失败" : "正在打包视频制作资料";
  const detail = isError
    ? isExpired ? "下载链接已过期，请重新创建下载任务。" : task.error || task.detail || "请稍后重试。"
    : task.detail || (type === "timeline" ? `已处理 ${task.done || 0}/${task.total || 0} 个分镜组` : isResultPackage ? `正在读取并压缩 ${task.total || 0} 个视频` : `正在读取并压缩 ${task.total || 0} 张图片`);
  const downloadName = isResultPackage ? "视频结果.zip" : "video-materials.zip";
  const downloadLabel = isResultPackage ? "下载视频结果" : "下载制作资料";
  return (
    <div className={`workflow-video-task-card-next ${isRunning ? "running" : ""} ${isIndeterminate ? "indeterminate" : ""} ${isDone ? "done" : ""} ${isError ? "error" : ""}`}>
      <div className="workflow-video-task-head-next">
        <div>
          <strong>{title}</strong>
          <span>{detail}</span>
          {isDone && isPackage && task.expiresAt ? <span>下载链接 {workflowPackageExpiresText(task.expiresAt)}。</span> : null}
        </div>
        <span>{isIndeterminate ? "处理中" : `${progress}%`}</span>
      </div>
      <div className="workflow-image-package-progress-next" aria-label={`视频制作进度 ${progress}%`}>
        <span style={{ width: `${progress}%` }} />
      </div>
      {isPackage && (isDone || isExpired) ? (
        <div className="workflow-image-package-actions-next">
          <code>{task.fileName || downloadName}</code>
          {isExpired ? (
            <div className="workflow-image-package-button-row-next">
              <button className="primary-action compact" type="button" disabled>
                下载链接已失效
              </button>
              {onDelete ? (
                <button className="secondary-action compact danger-soft-next" type="button" onClick={() => onDelete(task)}>
                  删除链接
                </button>
              ) : null}
            </div>
          ) : task.downloadPath ? (
            <div className="workflow-image-package-button-row-next">
              <a className="primary-action compact" href={buildImageZipDownloadUrl(task.downloadPath)} download={task.fileName || downloadName}>
                {downloadLabel}
              </a>
              {onDelete ? (
                <button className="secondary-action compact danger-soft-next" type="button" onClick={() => onDelete(task)}>
                  删除链接
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {type === "package" && isError && onBrowserPackage ? (
        <div className="workflow-browser-package-fallback-next">
          <span>可以重试上方服务器打包，或让当前浏览器直接读取图片并在本地生成 ZIP。</span>
          <button className="secondary-action compact" type="button" disabled={browserPackaging} onClick={onBrowserPackage}>
            {browserPackaging ? "浏览器打包中..." : "使用浏览器打包"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function WorkflowBrowserPackageCard({ task }) {
  const progress = Math.max(0, Math.min(100, Math.round(Number(task?.progress) || 0)));
  const isDone = task?.status === "done";
  const isError = task?.status === "error";
  return (
    <div className={`workflow-video-task-card-next browser-local ${isDone ? "done" : ""} ${isError ? "error" : ""}`}>
      <div className="workflow-video-task-head-next">
        <div>
          <strong>{isDone ? "浏览器本地打包已完成" : isError ? "浏览器本地打包失败" : "正在使用浏览器打包"}</strong>
          <span>{task?.detail || "正在读取图片，请保持当前页面打开。"}</span>
          {isDone ? <span>压缩包只下载到当前设备，不会生成服务器下载链接。</span> : null}
        </div>
        <span>{progress}%</span>
      </div>
      <div className="workflow-image-package-progress-next" aria-label={`浏览器打包进度 ${progress}%`}>
        <span style={{ width: `${progress}%` }} />
      </div>
      {task?.fileName ? <code>{task.fileName}</code> : null}
    </div>
  );
}

function WorkflowDialogPortal({ children }) {
  if (typeof document === "undefined") return null;
  return createPortal(children, document.body);
}

function WorkflowVideoGroupingDialog({ dialog, onChange, onClose, onConfirm }) {
  const total = Number(dialog.total) || 0;
  const selectedSize = Math.max(1, Math.min(5, Number(dialog.groupSize) || 1));
  const groups = workflowVideoGroupCount(total, selectedSize);
  const remainder = total % selectedSize;
  const ecommerce = Boolean(dialog.ecommerce);

  return (
    <WorkflowDialogPortal>
      <div className="workflow-image-dialog-backdrop-next" role="presentation" onClick={onClose}>
        <section className="workflow-image-retry-dialog-next workflow-video-group-dialog-next" role="dialog" aria-modal="true" aria-label={ecommerce ? "选择镜头分组" : "选择图片分组"} onClick={(event) => event.stopPropagation()}>
          <button className="workflow-dialog-close-next" type="button" onClick={onClose} aria-label="关闭">×</button>
          <div className="workflow-video-group-heading-next">
            <h3>选择镜头分组</h3>
          </div>
          <p className="workflow-dialog-description-next">按现有分镜数量选择每个视频片段包含几个镜头。</p>
          <div className="workflow-video-group-options-next">
            {[1, 2, 3, 4, 5].map((size) => (
              <button className={size === selectedSize ? "selected" : ""} type="button" onClick={() => onChange({ ...dialog, groupSize: size })} key={size}>
                <strong>{ecommerce ? `${size} 个镜头一组` : `${size} 张图一组`}</strong>
                <span>{workflowVideoGroupCount(total, size)} 个分镜组</span>
              </button>
            ))}
          </div>
          <article className="workflow-video-group-preview-next">
            <span>预计生成</span>
            <strong>{groups} 个分镜组</strong>
            <p>{ecommerce ? remainder ? `最后一组会包含剩余 ${remainder} 个镜头；组内场景图和角色图会自动去重。` : "每组镜头数量平均，组内场景图和角色图会自动去重。" : remainder ? `最后一组会包含剩余 ${remainder} 张图片。` : "每组图片数量平均，视频提示词会按组组合。"}</p>
          </article>
          <div className="workflow-dialog-actions-next">
            <button className="secondary-action" type="button" onClick={onClose}>取消</button>
            <button className="primary-action workflow-video-group-confirm-next" type="button" onClick={() => onConfirm({
              mode: "quick",
              groupSize: selectedSize,
            })}>添加时间线</button>
          </div>
        </section>
      </div>
    </WorkflowDialogPortal>
  );
}

function WorkflowVideoGenerateDialog({ dialog, videoKeys, submitting, onChange, onClose, onConfirm }) {
  const selected = workflowVideoSelectedCandidate(dialog, videoKeys);
  const selectedModel = selected?.model || null;
  const targets = workflowVideoDialogTargets(dialog);
  const updateDialog = (patch) => onChange((current) => current ? { ...current, ...patch } : current);
  const selectCandidate = (candidate) => {
    const model = candidate.model;
    updateDialog({
      apiKeyId: candidate.apiKey.id,
      modelId: model.id,
      modelProvider: model.provider,
      ratio: workflowVideoOptionValue(model.ratios, dialog.ratio) || workflowVideoOptionFirstValue(model.ratios),
      duration: optionValueOrFirst(model.durations || [], dialog.duration) || model.durations?.[0] || "5s",
      resolution: optionValueOrFirst(model.resolutions || [], dialog.resolution) || model.resolutions?.[0] || "720p",
      generationMode: workflowVideoOptionValue(model.modes, dialog.generationMode) || workflowVideoOptionFirstValue(model.modes),
    });
  };
  const confirmDisabled = submitting || !selected || !targets.length;
  const description = dialog.mode === "missing"
    ? `将生成 ${targets.length} 个缺失视频`
    : `${dialog.title || workflowVideoSegmentLabel(dialog.item, dialog.index)} · ${workflowVideoReferenceUrlsForItem(dialog.item, selectedModel || {}, dialog.generationMode).length} 张参考图`;
  return (
    <WorkflowDialogPortal>
      <div className="workflow-image-dialog-backdrop-next" role="presentation" onClick={onClose}>
        <section className="workflow-image-retry-dialog-next workflow-video-model-dialog-next" role="dialog" aria-modal="true" aria-label="选择视频生成模型" onClick={(event) => event.stopPropagation()}>
          <button className="workflow-dialog-close-next" type="button" onClick={onClose} aria-label="关闭">×</button>
          <div className="workflow-dialog-title-next workflow-video-model-title-next">
            <h3>选择视频生成模型</h3>
          </div>
          <p className="workflow-dialog-description-next">{description}</p>
          <div className="workflow-video-model-layout-next">
            <div className="workflow-video-provider-list-next">
              {(Array.isArray(videoKeys) ? videoKeys : []).length ? (
                videoKeys.map((apiKey) => {
                  const models = workflowVideoModelOptions(apiKey);
                  const channelLabel = formatApiChannelName(apiKey.channel || "视频渠道");
                  const displayName = apiKeyDisplayName(apiKey);
                  const showChannelLabel = normalizeWorkflowProviderName(channelLabel) !== normalizeWorkflowProviderName(displayName);
                  return (
                    <article className={`workflow-video-provider-card-next ${models.length ? "" : "disabled"}`} key={apiKey.id || apiKeyDisplayName(apiKey)}>
                      <div className="workflow-video-provider-head-next">
                        <div>
                          {showChannelLabel ? <span>{channelLabel}</span> : null}
                          <strong>{displayName}</strong>
                        </div>
                        <b>{models.length ? `${models.length} 个模型` : "未接入"}</b>
                      </div>
                      {models.length ? (
                        <div className="workflow-video-model-button-grid-next">
                          {models.map((model) => {
                            const isSelected = selected?.apiKey.id === apiKey.id && selected?.model.id === model.id;
                            return (
                              <button className={isSelected ? "selected" : ""} type="button" onClick={() => selectCandidate({ apiKey, model })} key={model.id}>
                                <span>⚡</span>
                                <strong>{model.name}</strong>
                              </button>
                            );
                          })}
                        </div>
                      ) : (
                        <p>请选择当前工作流支持的视频生成渠道。</p>
                      )}
                    </article>
                  );
                })
              ) : (
                <article className="workflow-video-provider-card-next disabled">
                  <div className="workflow-video-provider-head-next">
                    <div>
                      <span>视频渠道</span>
                      <strong>未配置 API</strong>
                    </div>
                  </div>
                  <p>请先在 API 设置里添加可用的视频生成 API Key。</p>
                </article>
              )}
            </div>
            <div className="workflow-video-model-params-next">
              {selectedModel ? (
                <>
                  <article className="workflow-video-model-summary-next">
                    <span>⚡</span>
                    <div>
                      <strong>已选择：{selectedModel.name}</strong>
                      <p>{selectedModel.description}</p>
                      <div className="workflow-video-model-tags-next">
                        {(selectedModel.tags || []).map((tag) => <span key={tag}>{tag}</span>)}
                      </div>
                    </div>
                  </article>
                  <div className="workflow-video-param-group-next">
                    <span>视频比例</span>
                    <div>
                      {(selectedModel.ratios || []).map((ratio) => (
                        <button className={dialog.ratio === ratio.value ? "selected" : ""} type="button" onClick={() => updateDialog({ ratio: ratio.value })} key={ratio.value}>
                          {ratio.value} {ratio.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="workflow-video-param-group-next">
                    <span>秒数</span>
                    <div>
                      {(selectedModel.durations || []).map((duration) => (
                        <button className={dialog.duration === duration ? "selected" : ""} type="button" onClick={() => updateDialog({ duration })} key={duration}>
                          {duration}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="workflow-video-param-group-next">
                    <span>生成模式</span>
                    <div>
                      {(selectedModel.modes || []).map((mode) => (
                        <button className={dialog.generationMode === mode.value ? "selected" : ""} type="button" onClick={() => updateDialog({ generationMode: mode.value })} key={mode.value}>
                          {mode.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="workflow-video-param-group-next">
                    <span>{"视频分辨率"}</span>
                    <div>
                      {(selectedModel.resolutions || []).map((resolution) => (
                        <button className={dialog.resolution === resolution ? "selected" : ""} type="button" onClick={() => updateDialog({ resolution })} key={resolution}>
                          {resolution}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              ) : (
                <article className="workflow-video-model-empty-next">
                  <strong>暂无可用模型</strong>
                  <p>请先配置可用的视频生成 API Key。</p>
                </article>
              )}
            </div>
          </div>
          <div className="workflow-dialog-actions-next workflow-video-model-actions-next">
            <button className="secondary-action compact" type="button" onClick={onClose}>取消</button>
            <button className="primary-action compact" type="button" disabled={confirmDisabled} onClick={() => onConfirm(dialog)}>
              {submitting ? "提交中..." : "确认生成"}
            </button>
          </div>
        </section>
      </div>
    </WorkflowDialogPortal>
  );
}

function WorkflowRoleWatermarkDialog({ dialog, onChange, onClose, onConfirm }) {
  const assetType = dialog.assetType === "scene" ? "scene" : "role";
  const assetLabel = assetType === "scene" ? "场景图" : "角色图";
  const assetNameLabel = assetType === "scene" ? "场景名" : "角色名";
  const watermarkMode = dialog.watermarkMode === "custom" ? "custom" : assetType;
  const shotIds = Array.isArray(dialog.shotIds) ? dialog.shotIds : [];
  const targetCount = Number(dialog.targetCount || shotIds.length) || 0;
  const customText = workflowWatermarkCustomText(dialog.customText || "");
  const confirmDisabled = !targetCount || (watermarkMode === "custom" && !customText);
  const updateDialog = (patch) => onChange((current) => current ? { ...current, ...patch } : current);

  return (
    <WorkflowDialogPortal>
      <div className="workflow-image-dialog-backdrop-next" role="presentation" onClick={onClose}>
        <section className="workflow-image-retry-dialog-next workflow-watermark-dialog-next" role="dialog" aria-modal="true" aria-label="增加水印" onClick={(event) => event.stopPropagation()}>
          <button className="workflow-dialog-close-next" type="button" onClick={onClose} aria-label="关闭">×</button>
          <div className="workflow-dialog-title-next">
            <span>WATERMARK</span>
            <h3>增加水印</h3>
            <p>{targetCount ? `将给 ${targetCount} 张${assetLabel}增加水印。` : `请选择要增加水印的${assetLabel}。`}</p>
          </div>
          <article className="workflow-dialog-step-next">
            <span>应用范围</span>
            <strong>{targetCount} 张{assetLabel}</strong>
            <p>水印会直接写入图片；之后仍可通过“取消水印”恢复到原图。</p>
          </article>
          <div className="workflow-dialog-fields-next">
            <div>
              <div className="workflow-dialog-field-label-next">水印内容</div>
              <div className="workflow-segmented-next workflow-watermark-mode-tabs-next">
                <button className={watermarkMode === assetType ? "selected" : ""} type="button" onClick={() => updateDialog({ watermarkMode: assetType })}>
                  {assetNameLabel}
                </button>
                <button className={watermarkMode === "custom" ? "selected" : ""} type="button" onClick={() => updateDialog({ watermarkMode: "custom" })}>
                  自定义文字
                </button>
              </div>
            </div>
            {watermarkMode === "custom" ? (
              <label>
                自定义文字
                <input
                  value={dialog.customText || ""}
                  onChange={(event) => updateDialog({ customText: event.target.value.slice(0, 32) })}
                  placeholder="输入水印文字"
                  maxLength={32}
                  autoFocus
                />
              </label>
            ) : (
              <p className="workflow-watermark-dialog-note-next">使用每张{assetType === "scene" ? "场景" : "角色"}资产当前显示的{assetNameLabel}。</p>
            )}
          </div>
          <div className="workflow-dialog-actions-next">
            <button className="secondary-action compact" type="button" onClick={onClose}>取消</button>
            <button className="primary-action compact" type="button" disabled={confirmDisabled} onClick={() => onConfirm({ ...dialog, watermarkMode, customText })}>
              应用水印
            </button>
          </div>
        </section>
      </div>
    </WorkflowDialogPortal>
  );
}

function VideoFinalResultSection({ summary, videoResultPackageJob, downloadingVideoResults, queryingVideoResultIds = [], onRefresh, onDeleteVideoResult, onDeleteVideoResults, onDownloadVideoResults, onDeleteVideoResultPackage, onQueryVideoResult, onRecoverVideoTaskId, onResumeVideoQueue }) {
  const categoryCounts = workflowVideoResultCategoryCounts(summary.videoResults);
  const [activeCategory, setActiveCategory] = useState(workflowVideoDefaultCategory(summary.videoResults));
  const [selectedVideoIds, setSelectedVideoIds] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    if (!summary.videoResults.length) return;
    if (categoryCounts[activeCategory] > 0) return;
    setActiveCategory(workflowVideoDefaultCategory(summary.videoResults));
  }, [activeCategory, categoryCounts.done, categoryCounts.processing, categoryCounts.failed, summary.videoResults]);
  useEffect(() => {
    const availableIds = new Set(summary.videoResults.map(workflowVideoSelectableId));
    setSelectedVideoIds((current) => current.filter((id) => availableIds.has(id)));
  }, [summary.videoResults]);
  useEffect(() => {
    setSelectedVideoIds([]);
  }, [activeCategory]);

  if (!summary.videoResults.length) {
    return (
      <section className="workflow-run-section-card-next">
        <div className="workflow-run-section-title-next compact">
          <div>
            <h4>视频结果</h4>
            <p>视频生成完成后，会在这里集中展示和下载。</p>
          </div>
          <span>{summary.videoStatus ? workflowStatusLabel(summary.videoStatus) : "暂无视频"}</span>
        </div>
        <article className="workflow-video-empty-next">
          <span>▶</span>
          <h4>还没有视频结果</h4>
          <p>请先在“视频制作”页面整理资料，后续生成的视频会进入这里。</p>
        </article>
      </section>
    );
  }

  const categories = [
    { id: "done", label: "已完成", count: categoryCounts.done },
    { id: "processing", label: "处理中", count: categoryCounts.processing },
    { id: "failed", label: "已失败", count: categoryCounts.failed },
  ];
  const allEntries = summary.videoResults.map((video, index) => ({
    video,
    index,
    id: workflowVideoSelectableId(video, index),
  }));
  const filteredEntries = allEntries.filter((entry) => workflowVideoResultCategory(entry.video) === activeCategory);
  const selectedVideos = allEntries
    .filter((entry) => selectedVideoIds.includes(entry.id))
    .map((entry) => entry.video);
  const selectedCompletedVideos = selectedVideos.filter((video) => workflowVideoUrl(video));
  const pausedVideos = summary.videoResults.filter(workflowVideoResultIsPausedQueued);
  const filteredIds = filteredEntries.map((entry) => entry.id);
  const allFilteredSelected = Boolean(filteredIds.length) && filteredIds.every((id) => selectedVideoIds.includes(id));
  const toggleSelectAll = () => {
    if (allFilteredSelected) {
      setSelectedVideoIds((current) => current.filter((id) => !filteredIds.includes(id)));
      return;
    }
    setSelectedVideoIds((current) => [...new Set([...current, ...filteredIds])]);
  };
  const toggleSelectedVideo = (id) => {
    setSelectedVideoIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };
  const handleRefresh = async () => {
    if (!onRefresh || refreshing) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };
  const handleBatchDelete = async () => {
    if (!selectedVideos.length) return;
    await onDeleteVideoResults?.(selectedVideos);
    setSelectedVideoIds([]);
  };
  const handleDownload = async () => {
    if (!selectedCompletedVideos.length) return;
    await onDownloadVideoResults?.(selectedCompletedVideos);
  };
  return (
    <section className="workflow-run-section-card-next">
      <div className="workflow-run-section-title-next compact">
        <div>
          <h4>视频结果</h4>
          <p>{workflowVideoResultsSummaryText(summary.videoResults)}</p>
        </div>
        <span>{summary.videoStatus ? workflowStatusLabel(summary.videoStatus) : `${summary.videoResults.length} 个任务`}</span>
      </div>
      <div className="workflow-video-result-toolbar-next">
        <div className="workflow-video-result-filter-next">
          {categories.map((category) => (
            <button className={activeCategory === category.id ? "selected" : ""} type="button" onClick={() => setActiveCategory(category.id)} key={category.id}>
              <span>{category.label}</span>
              <b>{category.count}</b>
            </button>
          ))}
          <button type="button" disabled={!onRefresh || refreshing} onClick={handleRefresh}>
            <span>{refreshing ? "刷新中" : "刷新"}</span>
          </button>
          {pausedVideos.length ? (
            <button type="button" disabled={!onResumeVideoQueue} onClick={() => onResumeVideoQueue?.(pausedVideos)}>
              <span>继续队列</span>
              <b>{pausedVideos.length}</b>
            </button>
          ) : null}
        </div>
        <div className="workflow-video-result-actions-next">
          <label className="workflow-video-select-all-next">
            <input type="checkbox" checked={allFilteredSelected} disabled={!filteredIds.length} onChange={toggleSelectAll} />
            <span>全选</span>
          </label>
          <button className="secondary-action compact danger-soft-next" type="button" disabled={!selectedVideos.length} onClick={handleBatchDelete}>
            批量删除{selectedVideos.length ? `(${selectedVideos.length})` : ""}
          </button>
          <button className="secondary-action compact" type="button" disabled={!selectedCompletedVideos.length || downloadingVideoResults} onClick={handleDownload}>
            {downloadingVideoResults ? "创建中..." : `创建下载任务${selectedCompletedVideos.length ? `(${selectedCompletedVideos.length})` : ""}`}
          </button>
        </div>
      </div>
      {videoResultPackageJob || summary.videoResultPackageStatus || summary.videoResultPackageDetail || summary.videoResultPackageError ? (
        <WorkflowVideoTaskCard
          task={videoResultPackageJob || {
            id: summary.videoResultPackage?.id,
            status: summary.videoResultPackageStatus,
            progress: summary.videoResultPackageProgress || (summary.videoResultPackageStatus === "done" || summary.videoResultPackageStatus === "error" ? 100 : 0),
            done: summary.videoResultPackageDone || 0,
            total: summary.videoResultPackageTotal || 0,
            detail: summary.videoResultPackageDetail,
            error: summary.videoResultPackageError,
            fileName: summary.videoResultPackageName,
            expiresAt: summary.videoResultPackageExpiresAt,
            downloadPath: summary.videoResultPackageDownloadPath,
          }}
          type="resultPackage"
          onDelete={onDeleteVideoResultPackage}
        />
      ) : null}
      {!filteredEntries.length ? (
        <article className="workflow-video-empty-next compact">
          <span>▶</span>
          <h4>暂无{categories.find((category) => category.id === activeCategory)?.label || ""}任务</h4>
          <p>切换上方分类可查看其他状态的视频任务。</p>
        </article>
      ) : null}
      <div className="workflow-video-result-grid-next">
        {filteredEntries.map((entry) => (
          <VideoResultCard
            video={entry.video}
            index={entry.index}
            selected={selectedVideoIds.includes(entry.id)}
            onToggleSelected={() => toggleSelectedVideo(entry.id)}
            onDelete={() => onDeleteVideoResult?.(entry.video, entry.index)}
            querying={queryingVideoResultIds.includes(entry.id)}
            onQuery={() => onQueryVideoResult?.(entry.video)}
            onRecoverTaskId={(taskId) => onRecoverVideoTaskId?.(entry.video, taskId)}
            onResume={() => onResumeVideoQueue?.([entry.video])}
            key={entry.id}
          />
        ))}
      </div>
    </section>
  );
}

function CopyButton({ text, label }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="secondary-action compact workflow-copy-button-next"
      type="button"
      disabled={!text}
      onClick={async () => {
        await copyWorkflowText(text);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 900);
      }}
    >
      {copied ? "已复制" : label}
    </button>
  );
}

function ShotResultCard({ shot, index }) {
  const imageUrl = workflowShotImageUrl(shot);
  const shotNumber = workflowShotNumber(shot, index);
  const prompt = stringFromWorkflowValue(shot.imagePrompt || shot.prompt || shot.description || shot.text);
  const script = stringFromWorkflowValue(shot.script || shot.copy || shot.voiceover || shot.narration);

  return (
    <article>
      <span className="workflow-shot-result-index-next">{shotNumber}</span>
      <div>
        {script ? (
          <div className="workflow-shot-field-next">
            <b>对应文案</b>
            <p>{script}</p>
          </div>
        ) : null}
        <div className="workflow-shot-field-next">
          <b>画面提示词</b>
          <p>{prompt || "暂无分镜描述"}</p>
        </div>
        {imageUrl ? <a className="secondary-action compact" href={imageUrl} target="_blank" rel="noreferrer">查看图片</a> : null}
        {shot.imageError ? <p className="workflow-run-danger-text-next">{shot.imageError}</p> : null}
        {shot.imagePauseReason ? <p>{shot.imagePauseReason}</p> : null}
      </div>
    </article>
  );
}

function WorkflowImagePreview({ image, onClose }) {
  const [downloading, setDownloading] = useState(false);
  async function handleDownload() {
    if (!image?.url || downloading) return;
    setDownloading(true);
    try {
      const result = await downloadToolImage({
        url: image.url,
        fileName: safeWorkflowImageFileName(image.title || "分镜图片"),
      });
      downloadWorkflowBlob(result.blob, result.fileName || safeWorkflowImageFileName(image.title || "分镜图片"));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <WorkflowDialogPortal>
      <div className="workflow-image-dialog-backdrop-next" role="presentation" onClick={onClose}>
        <section className="workflow-image-preview-dialog-next" role="dialog" aria-modal="true" aria-label="预览分镜图片" onClick={(event) => event.stopPropagation()}>
          <button className="workflow-dialog-close-next" type="button" onClick={onClose}>×</button>
          <img src={image.url} alt={image.alt || "分镜图片预览"} />
          <div>
            <strong>{image.title || "分镜图片"}</strong>
            <button className="secondary-action compact" type="button" disabled={downloading} onClick={handleDownload}>
              {downloading ? "下载中..." : "下载图片"}
            </button>
          </div>
        </section>
      </div>
    </WorkflowDialogPortal>
  );
}

function WorkflowRunActionDialog({ dialog, llmKeys, imageKeys = [], audioKeys = [], queueing, onChange, onClose, onConfirm }) {
  const usesModel = ["script", "shot", "compliance", "optimization"].includes(dialog.mode);
  const usesShotImageToggle = dialog.mode === "shot";
  const allowsAiDirectorStoryboard = usesShotImageToggle && Boolean(dialog.allowAiDirectorStoryboard);
  const aiDirectorStoryboard = allowsAiDirectorStoryboard && dialog.storyboardMode === "ai-director";
  const usesTalkingShotSegmentation = usesShotImageToggle && Boolean(dialog.talkingVideoWorkflow);
  const usesImageModel = usesShotImageToggle && Boolean(dialog.autoImages);
  const allowsOutfitVariantDetection = usesShotImageToggle && dialog.allowRoleOutfitVariantDetection !== false;
  const usesOutfitVariantDetection = allowsOutfitVariantDetection && Boolean(dialog.roleOutfitVariantDetection);
  const usesAudioChoices = dialog.mode === "audio";
  const selectedKey = llmKeys.find((key) => key.id === dialog.apiId) || null;
  const models = workflowLlmModelOptions(selectedKey);
  const modelValue = models.some((model) => model.id === dialog.modelId) ? dialog.modelId : models[0]?.id || "";
  const selectedOutfitLlmKey = llmKeys.find((key) => key.id === dialog.outfitDetectionLlmKeyId) || null;
  const outfitDetectionModels = workflowLlmModelOptions(selectedOutfitLlmKey);
  const outfitDetectionModelValue = outfitDetectionModels.some((model) => model.id === dialog.outfitDetectionModelId) ? dialog.outfitDetectionModelId : outfitDetectionModels[0]?.id || "";
  const selectedImageKey = imageKeys.find((key) => key.id === dialog.imageKeyId) || null;
  const imageModels = workflowImageModelOptions(selectedImageKey);
  const imageModelValue = imageModels.some((model) => model.id === dialog.imageModelId) ? dialog.imageModelId : imageModels[0]?.id || "";
  const selectedImageModel = imageModels.find((model) => model.id === imageModelValue) || imageModels[0] || null;
  const imageResolutionOptions = selectedImageModel?.resolutions || [];
  const imageResolutionValue = optionValueOrFirst(imageResolutionOptions, dialog.imageResolution || "");
  const imageRatioOptions = workflowImageRatioOptions(selectedImageModel);
  const imageRatioValue = optionValueOrFirst(imageRatioOptions.map((ratio) => ratio.value), dialog.ratio || "");
  const customImageSizeRequired = usesImageModel && imageRatioValue === "custom";
  const selectedOutfitImageKey = imageKeys.find((key) => key.id === dialog.outfitImageKeyId) || null;
  const outfitImageModels = workflowImageModelOptions(selectedOutfitImageKey);
  const outfitImageModelValue = outfitImageModels.some((model) => model.id === dialog.outfitImageModelId) ? dialog.outfitImageModelId : outfitImageModels[0]?.id || "";
  const selectedOutfitImageModel = outfitImageModels.find((model) => model.id === outfitImageModelValue) || outfitImageModels[0] || null;
  const outfitImageResolutionValue = optionValueOrFirst(selectedOutfitImageModel?.resolutions || [], dialog.outfitImageResolution || "");
  const outfitImageRatioOptions = workflowImageRatioOptions(selectedOutfitImageModel);
  const outfitImageRatioValue = optionValueOrFirst(outfitImageRatioOptions.map((ratio) => ratio.value), dialog.outfitImageRatio || "1:1");
  const customOutfitImageSizeRequired = usesOutfitVariantDetection && outfitImageRatioValue === "custom";
  const selectedAudioKey = audioKeys.find((key) => key.id === dialog.audioKeyId) || null;
  const audioModels = workflowAudioModelOptions(selectedAudioKey);
  const audioModelValue = audioModels.some((model) => model.id === dialog.audioModelId) ? dialog.audioModelId : audioModels[0]?.id || "";
  const audioVoiceMode = dialog.audioVoicePresetId || "default";

  useEffect(() => {
    if (!usesModel || !dialog.apiId) return;
    if (dialog.modelId === modelValue) return;
    onChange((current) => current ? { ...current, modelId: modelValue } : current);
  }, [usesModel, dialog.apiId, dialog.modelId, modelValue]);

  useEffect(() => {
    if (!usesOutfitVariantDetection || !dialog.outfitDetectionLlmKeyId) return;
    if (dialog.outfitDetectionModelId === outfitDetectionModelValue) return;
    onChange((current) => current ? { ...current, outfitDetectionModelId: outfitDetectionModelValue } : current);
  }, [usesOutfitVariantDetection, dialog.outfitDetectionLlmKeyId, dialog.outfitDetectionModelId, outfitDetectionModelValue]);

  useEffect(() => {
    if (!usesImageModel || !dialog.imageKeyId) return;
    const nextImageSize = workflowImageRequestSize(imageRatioValue);
    const patch = {};
    if (dialog.imageModelId !== imageModelValue) patch.imageModelId = imageModelValue;
    if (imageResolutionValue && dialog.imageResolution !== imageResolutionValue) patch.imageResolution = imageResolutionValue;
    if (imageRatioValue && dialog.ratio !== imageRatioValue) patch.ratio = imageRatioValue;
    if (dialog.imageSize !== nextImageSize) patch.imageSize = nextImageSize;
    if (!Object.keys(patch).length) return;
    onChange((current) => current ? { ...current, ...patch } : current);
  }, [usesImageModel, dialog.imageKeyId, dialog.imageModelId, dialog.imageResolution, dialog.ratio, dialog.imageSize, imageModelValue, imageResolutionValue, imageRatioValue]);

  useEffect(() => {
    if (!usesOutfitVariantDetection || !dialog.outfitImageKeyId) return;
    const nextImageSize = workflowImageRequestSize(outfitImageRatioValue);
    const patch = {};
    if (dialog.outfitImageModelId !== outfitImageModelValue) patch.outfitImageModelId = outfitImageModelValue;
    if (outfitImageResolutionValue && dialog.outfitImageResolution !== outfitImageResolutionValue) patch.outfitImageResolution = outfitImageResolutionValue;
    if (outfitImageRatioValue && dialog.outfitImageRatio !== outfitImageRatioValue) patch.outfitImageRatio = outfitImageRatioValue;
    if (dialog.outfitImageSize !== nextImageSize) patch.outfitImageSize = nextImageSize;
    if (!Object.keys(patch).length) return;
    onChange((current) => current ? { ...current, ...patch } : current);
  }, [usesOutfitVariantDetection, dialog.outfitImageKeyId, dialog.outfitImageModelId, dialog.outfitImageResolution, dialog.outfitImageRatio, dialog.outfitImageSize, outfitImageModelValue, outfitImageResolutionValue, outfitImageRatioValue]);

  useEffect(() => {
    if (!usesAudioChoices || !dialog.audioKeyId) return;
    if (dialog.audioModelId === audioModelValue) return;
    onChange((current) => current ? { ...current, audioModelId: audioModelValue } : current);
  }, [usesAudioChoices, dialog.audioKeyId, dialog.audioModelId, audioModelValue]);

  function updateApi(apiId) {
    const key = llmKeys.find((item) => item.id === apiId) || null;
    const nextModels = workflowLlmModelOptions(key);
    onChange((current) => current ? {
      ...current,
      apiId,
      modelId: nextModels[0]?.id || "",
    } : current);
  }

  function updateOutfitDetectionApi(outfitDetectionLlmKeyId) {
    const key = llmKeys.find((item) => item.id === outfitDetectionLlmKeyId) || null;
    const nextModels = workflowLlmModelOptions(key);
    onChange((current) => current ? {
      ...current,
      outfitDetectionLlmKeyId,
      outfitDetectionModelId: nextModels[0]?.id || "",
    } : current);
  }

  function updateImageApi(imageKeyId) {
    const key = imageKeys.find((item) => item.id === imageKeyId) || null;
    const nextModels = workflowImageModelOptions(key);
    const nextModel = nextModels.find((model) => model.id === dialog.imageModelId) || nextModels[0] || null;
    const nextRatios = workflowImageRatioOptions(nextModel);
    const nextRatio = optionValueOrFirst(nextRatios.map((ratio) => ratio.value), dialog.ratio || "");
    onChange((current) => current ? {
      ...current,
      imageKeyId,
      imageModelId: nextModel?.id || "",
      imageResolution: optionValueOrFirst(nextModel?.resolutions || [], current.imageResolution || ""),
      ratio: nextRatio,
      imageSize: workflowImageRequestSize(nextRatio),
    } : current);
  }

  function updateImageModel(imageModelId) {
    const nextModel = imageModels.find((model) => model.id === imageModelId) || imageModels[0] || null;
    const nextRatios = workflowImageRatioOptions(nextModel);
    const nextRatio = optionValueOrFirst(nextRatios.map((ratio) => ratio.value), dialog.ratio || "");
    onChange((current) => current ? {
      ...current,
      imageModelId,
      imageResolution: optionValueOrFirst(nextModel?.resolutions || [], current.imageResolution || ""),
      ratio: nextRatio,
      imageSize: workflowImageRequestSize(nextRatio),
    } : current);
  }

  function updateImageField(field, value) {
    onChange((current) => {
      if (!current) return current;
      if (field === "ratio") {
        return {
          ...current,
          ratio: value,
          imageSize: workflowImageRequestSize(value),
        };
      }
      return { ...current, [field]: value };
    });
  }

  function updateOutfitImageApi(outfitImageKeyId) {
    const key = imageKeys.find((item) => item.id === outfitImageKeyId) || null;
    const nextModels = workflowImageModelOptions(key);
    const nextModel = nextModels.find((model) => model.id === dialog.outfitImageModelId) || nextModels[0] || null;
    const nextRatios = workflowImageRatioOptions(nextModel);
    const nextRatio = optionValueOrFirst(nextRatios.map((ratio) => ratio.value), dialog.outfitImageRatio || "1:1");
    onChange((current) => current ? {
      ...current,
      outfitImageKeyId,
      outfitImageModelId: nextModel?.id || "",
      outfitImageResolution: optionValueOrFirst(nextModel?.resolutions || [], current.outfitImageResolution || ""),
      outfitImageRatio: nextRatio,
      outfitImageSize: workflowImageRequestSize(nextRatio),
    } : current);
  }

  function updateOutfitImageModel(outfitImageModelId) {
    const nextModel = outfitImageModels.find((model) => model.id === outfitImageModelId) || outfitImageModels[0] || null;
    const nextRatios = workflowImageRatioOptions(nextModel);
    const nextRatio = optionValueOrFirst(nextRatios.map((ratio) => ratio.value), dialog.outfitImageRatio || "1:1");
    onChange((current) => current ? {
      ...current,
      outfitImageModelId,
      outfitImageResolution: optionValueOrFirst(nextModel?.resolutions || [], current.outfitImageResolution || ""),
      outfitImageRatio: nextRatio,
      outfitImageSize: workflowImageRequestSize(nextRatio),
    } : current);
  }

  function updateOutfitImageField(field, value) {
    onChange((current) => {
      if (!current) return current;
      if (field === "outfitImageRatio") {
        return {
          ...current,
          outfitImageRatio: value,
          outfitImageSize: workflowImageRequestSize(value),
        };
      }
      return { ...current, [field]: value };
    });
  }

  function updateShotAutoImages(autoImages) {
    onChange((current) => {
      if (!current) return current;
      if (!autoImages) return { ...current, autoImages: false };
      const imageKey = imageKeys.find((key) => key.id === current.imageKeyId) || imageKeys[0] || null;
      const nextModels = workflowImageModelOptions(imageKey);
      const nextModelId = nextModels.some((model) => model.id === current.imageModelId) ? current.imageModelId : nextModels[0]?.id || "";
      const nextModel = nextModels.find((model) => model.id === nextModelId) || nextModels[0] || null;
      const nextRatios = workflowImageRatioOptions(nextModel);
      const nextRatio = optionValueOrFirst(nextRatios.map((ratio) => ratio.value), current.ratio || "");
      return {
        ...current,
        autoImages: true,
        imageKeyId: imageKey?.id || current.imageKeyId || "",
        imageModelId: nextModelId,
        imageResolution: optionValueOrFirst(nextModel?.resolutions || [], current.imageResolution || ""),
        ratio: nextRatio,
        imageSize: workflowImageRequestSize(nextRatio),
        customSize: current.customSize || "",
      };
    });
  }

  function updateRoleOutfitVariantDetection(roleOutfitVariantDetection) {
    onChange((current) => {
      if (!current) return current;
      if (!roleOutfitVariantDetection) return { ...current, roleOutfitVariantDetection: false };
      const llmKey = llmKeys.find((key) => key.id === current.outfitDetectionLlmKeyId)
        || llmKeys.find((key) => key.id === current.apiId)
        || llmKeys[0]
        || null;
      const nextDetectionModels = workflowLlmModelOptions(llmKey);
      const imageKey = imageKeys.find((key) => key.id === current.outfitImageKeyId)
        || imageKeys.find((key) => key.id === current.imageKeyId)
        || imageKeys[0]
        || null;
      const nextImageModels = workflowImageModelOptions(imageKey);
      const nextImageModelId = nextImageModels.some((model) => model.id === current.outfitImageModelId)
        ? current.outfitImageModelId
        : nextImageModels.some((model) => model.id === current.imageModelId)
          ? current.imageModelId
          : nextImageModels[0]?.id || "";
      const nextImageModel = nextImageModels.find((model) => model.id === nextImageModelId) || nextImageModels[0] || null;
      const nextRatios = workflowImageRatioOptions(nextImageModel);
      const nextRatio = optionValueOrFirst(nextRatios.map((ratio) => ratio.value), current.outfitImageRatio || "1:1");
      return {
        ...current,
        roleOutfitVariantDetection: true,
        outfitDetectionLlmKeyId: llmKey?.id || current.outfitDetectionLlmKeyId || current.apiId || "",
        outfitDetectionModelId: nextDetectionModels.some((model) => model.id === current.outfitDetectionModelId)
          ? current.outfitDetectionModelId
          : nextDetectionModels[0]?.id || "",
        outfitImageKeyId: imageKey?.id || current.outfitImageKeyId || current.imageKeyId || "",
        outfitImageModelId: nextImageModelId,
        outfitImageResolution: optionValueOrFirst(nextImageModel?.resolutions || [], current.outfitImageResolution || current.imageResolution || ""),
        outfitImageRatio: nextRatio,
        outfitImageSize: workflowImageRequestSize(nextRatio),
        outfitImageCustomSize: current.outfitImageCustomSize || "",
      };
    });
  }

  function updateAudioApi(audioKeyId) {
    const key = audioKeys.find((item) => item.id === audioKeyId) || null;
    const nextModels = workflowAudioModelOptions(key);
    onChange((current) => current ? {
      ...current,
      audioKeyId,
      audioModelId: nextModels[0]?.id || "",
    } : current);
  }

  function updateAudioField(field, value) {
    onChange((current) => current ? { ...current, [field]: value } : current);
  }

  function toggleAudioVariant(variant) {
    onChange((current) => {
      if (!current) return current;
      const selected = new Set(Array.isArray(current.audioVariants) ? current.audioVariants : []);
      if (selected.has(variant)) selected.delete(variant);
      else selected.add(variant);
      return {
        ...current,
        audioVariants: [...selected],
      };
    });
  }

  const disabledByModel = usesModel && (!dialog.apiId || !modelValue);
  const disabledByImageModel = usesImageModel && (
    !dialog.imageKeyId
    || !imageModelValue
    || !imageResolutionValue
    || !imageRatioValue
    || (customImageSizeRequired && !String(dialog.customSize || "").trim())
  );
  const disabledByOutfitVariant = usesOutfitVariantDetection && (
    !dialog.outfitDetectionLlmKeyId
    || !outfitDetectionModelValue
    || !dialog.outfitImageKeyId
    || !outfitImageModelValue
    || !outfitImageRatioValue
    || (customOutfitImageSizeRequired && !String(dialog.outfitImageCustomSize || "").trim())
  );
  const disabledByAudioChoices = usesAudioChoices && (
    !(Array.isArray(dialog.audioVariants) && dialog.audioVariants.length)
    || !dialog.audioKeyId
    || !audioModelValue
    || (audioVoiceMode === "saved" && !String(dialog.audioReferenceId || "").trim())
    || (audioVoiceMode === "clone" && !firstWorkflowArray(dialog.audioReferences).length)
  );
  const confirmText = dialog.mode === "shot"
    ? dialog.autoImages
      ? aiDirectorStoryboard ? "生成 AI 导演分镜并生成图片" : "生成分镜并生成图片"
      : usesOutfitVariantDetection
        ? aiDirectorStoryboard ? "生成 AI 导演分镜并检测变装" : "生成分镜并检测变装"
        : aiDirectorStoryboard ? "生成 AI 导演分镜" : "仅生成分镜"
    : dialog.confirmText || "确认";
  const noticeOnly = dialog.mode === "notice";

  return (
    <WorkflowDialogPortal>
      <div className="workflow-image-dialog-backdrop-next" role="presentation" onClick={queueing ? undefined : onClose}>
        <section className={`workflow-image-retry-dialog-next workflow-action-dialog-next ${dialog.mode === "shot" ? "workflow-action-dialog-shot-next" : ""}`} role="dialog" aria-modal="true" aria-label={dialog.title} onClick={(event) => event.stopPropagation()}>
        <button className="workflow-dialog-close-next" type="button" disabled={queueing} onClick={onClose}>×</button>
        <div className="workflow-dialog-title-next">
          {!noticeOnly && dialog.mode !== "shot" ? <span>{dialog.mode === "confirm" ? "Confirm" : dialog.mode === "audio" ? "Audio" : dialog.mode === "compliance" ? "Review" : dialog.mode === "optimization" ? "Optimize" : "Regenerate"}</span> : null}
          <h3>{dialog.title}</h3>
          <p>{dialog.summary}</p>
        </div>
        <article className={`workflow-dialog-step-next ${dialog.tone || ""}`}>
          <span>{usesModel || usesAudioChoices ? "执行节点" : "操作对象"}</span>
          <strong>{usesModel ? dialog.mode === "script" ? "文案生成" : dialog.mode === "shot" ? "分镜生成" : dialog.mode === "compliance" ? "违规风险检测" : "自定义优化" : usesAudioChoices ? "音频生成" : dialog.target}</strong>
          <p>{dialog.hint}</p>
        </article>
        {allowsAiDirectorStoryboard ? (
          <div className="workflow-dialog-fields-next">
            <div>
              <div className="workflow-dialog-field-label-next">分镜模式</div>
              <div className="workflow-video-group-options-next workflow-video-mode-options-next">
                <button
                  className={!aiDirectorStoryboard ? "selected" : ""}
                  type="button"
                  onClick={() => onChange((current) => current ? { ...current, storyboardMode: "traditional" } : current)}
                >
                  <strong>传统分镜</strong>
                  <span>保留原分镜结构，生成角色与场景映射</span>
                </button>
                <button
                  className={aiDirectorStoryboard ? "selected" : ""}
                  type="button"
                  onClick={() => onChange((current) => current ? { ...current, storyboardMode: "ai-director" } : current)}
                >
                  <strong>AI 导演分镜</strong>
                  <span>基于完整剧本重做切镜、时间码和人物表演</span>
                </button>
              </div>
            </div>
            {aiDirectorStoryboard ? (
              <div>
                <div className="workflow-dialog-field-label-next">单条视频最大时长</div>
                <div className="workflow-video-group-options-next workflow-video-duration-options-next">
                  {[10, 15].map((duration) => (
                    <button
                      className={Number(dialog.maxDurationSeconds) === duration ? "selected" : ""}
                      type="button"
                      onClick={() => onChange((current) => current ? { ...current, maxDurationSeconds: duration } : current)}
                      key={duration}
                    >
                      <strong>最大 {duration} 秒</strong>
                      <span>{duration === 10 ? "每镜 4–10 秒，最终时长为整数" : "每镜 10–15 秒，最终时长为整数"}</span>
                    </button>
                  ))}
                </div>
                <p className="workflow-field-help-next">LLM 会直接决定镜头合并与拆分，并在本次分镜生成中一次性写好最终视频提示词正文。</p>
              </div>
            ) : null}
          </div>
        ) : null}
        {usesModel ? (
          <div className="workflow-dialog-fields-next">
            <label>
              LLM 渠道
              <select value={dialog.apiId || ""} onChange={(event) => updateApi(event.target.value)}>
                <option value="">请选择 LLM 渠道</option>
                {llmKeys.map((key) => (
                  <option value={key.id} key={key.id}>{apiKeyDisplayName(key)}</option>
                ))}
              </select>
            </label>
            <label>
              模型
              <select value={modelValue} onChange={(event) => onChange((current) => current ? { ...current, modelId: event.target.value } : current)} disabled={!dialog.apiId}>
                {models.length ? models.map((model) => (
                  <option value={model.id} key={model.id}>{model.name}</option>
                )) : <option value="">请先选择 LLM 渠道</option>}
              </select>
            </label>
          </div>
        ) : null}
        {usesTalkingShotSegmentation ? (
          <div className="workflow-dialog-fields-next workflow-dialog-segmentation-next">
            <div className="workflow-dialog-field-label-next">分镜切分方式</div>
            <div className="workflow-dialog-choice-list-next" role="radiogroup" aria-label="分镜切分方式">
              <label className={`workflow-dialog-check-row-next ${dialog.talkingShotSegmentationMode !== "punctuation" ? "selected" : ""}`}>
                <input
                  type="radio"
                  name="talking-shot-segmentation"
                  value="duration-semantic"
                  checked={dialog.talkingShotSegmentationMode !== "punctuation"}
                  onChange={() => onChange((current) => current ? { ...current, talkingShotSegmentationMode: "duration-semantic" } : current)}
                />
                <span>
                  <strong>按配音时长智能切分（推荐）</strong>
                  <small>根据音频 ASR 原始时间码先切成约 5 秒一段，再优先调整到完整语义边界，并生成最终 SRT。</small>
                </span>
              </label>
              <label className={`workflow-dialog-check-row-next ${dialog.talkingShotSegmentationMode === "punctuation" ? "selected" : ""}`}>
                <input
                  type="radio"
                  name="talking-shot-segmentation"
                  value="punctuation"
                  checked={dialog.talkingShotSegmentationMode === "punctuation"}
                  onChange={() => onChange((current) => current ? { ...current, talkingShotSegmentationMode: "punctuation" } : current)}
                />
                <span>
                  <strong>按标点切分</strong>
                  <small>延续原有逻辑，在逗号、句号、问号、感叹号、破折号等标点处切分镜头。</small>
                </span>
              </label>
            </div>
          </div>
        ) : null}
        {allowsOutfitVariantDetection ? (
          <div className="workflow-dialog-fields-next workflow-dialog-outfit-toggle-next">
            <label className="workflow-dialog-check-row-next">
              <input
                type="checkbox"
                checked={Boolean(dialog.roleOutfitVariantDetection)}
                onChange={(event) => updateRoleOutfitVariantDetection(event.target.checked)}
              />
              <span>
                <strong>检测并补齐变装角色图</strong>
                <small>开启后会检测故事里的年龄、服装、伪装等明显状态变化，必要时生成当前 Run 专用角色图。</small>
              </span>
            </label>
          </div>
        ) : null}
        {usesOutfitVariantDetection ? (
          <div className="workflow-dialog-fields-next workflow-dialog-outfit-fields-next">
            <div className="workflow-control-row-next">
              <label>
                检测 LLM 渠道
                <select value={dialog.outfitDetectionLlmKeyId || ""} onChange={(event) => updateOutfitDetectionApi(event.target.value)}>
                  <option value="">请选择 LLM 渠道</option>
                  {llmKeys.map((key) => (
                    <option value={key.id} key={key.id}>{apiKeyDisplayName(key)}</option>
                  ))}
                </select>
              </label>
              <label>
                检测 LLM 模型
                <select value={outfitDetectionModelValue} onChange={(event) => onChange((current) => current ? { ...current, outfitDetectionModelId: event.target.value } : current)} disabled={!dialog.outfitDetectionLlmKeyId}>
                  {outfitDetectionModels.length ? outfitDetectionModels.map((model) => (
                    <option value={model.id} key={model.id}>{model.name}</option>
                  )) : <option value="">请先选择 LLM 渠道</option>}
                </select>
              </label>
            </div>
            <div className="workflow-control-row-next">
              <label>
                补图渠道
                <select value={dialog.outfitImageKeyId || ""} onChange={(event) => updateOutfitImageApi(event.target.value)}>
                  <option value="">请选择图片渠道</option>
                  {imageKeys.map((key) => (
                    <option value={key.id} key={key.id}>{apiKeyDisplayName(key)}</option>
                  ))}
                </select>
              </label>
              <label>
                补图模型
                <select value={outfitImageModelValue} onChange={(event) => updateOutfitImageModel(event.target.value)} disabled={!dialog.outfitImageKeyId}>
                  {outfitImageModels.length ? outfitImageModels.map((model) => (
                    <option value={model.id} key={model.id}>{model.name}</option>
                  )) : <option value="">请先选择图片渠道</option>}
                </select>
              </label>
            </div>
            <label>
              补图分辨率
              <select value={outfitImageResolutionValue} onChange={(event) => updateOutfitImageField("outfitImageResolution", event.target.value)} disabled={!dialog.outfitImageKeyId || !outfitImageModelValue}>
                {(selectedOutfitImageModel?.resolutions || []).length ? selectedOutfitImageModel.resolutions.map((resolution) => (
                  <option value={resolution} key={resolution}>{resolution}</option>
                )) : <option value="">默认</option>}
              </select>
            </label>
            <div>
              <div className="workflow-dialog-field-label-next">补图比例 / 尺寸</div>
              <div className="workflow-ratio-grid-next">
                {outfitImageRatioOptions.length ? outfitImageRatioOptions.map((ratio) => (
                  <button className={outfitImageRatioValue === ratio.value ? "selected" : ""} type="button" onClick={() => updateOutfitImageField("outfitImageRatio", ratio.value)} key={ratio.value}>
                    {ratio.label}<small>{ratio.detail || ratio.value}</small>
                  </button>
                )) : <span className="workflow-field-help-next">请先选择图片渠道和模型</span>}
              </div>
            </div>
            {customOutfitImageSizeRequired ? (
              <label>
                自定义尺寸
                <input value={dialog.outfitImageCustomSize || ""} onChange={(event) => updateOutfitImageField("outfitImageCustomSize", event.target.value)} placeholder="例如 1280x1280" />
                <span className="workflow-field-help-next">宽高建议使用 16px 的倍数，最大边长不超过 3840px。</span>
              </label>
            ) : null}
          </div>
        ) : null}
        {usesShotImageToggle ? (
          <div className="workflow-dialog-fields-next workflow-dialog-image-toggle-next">
            <label className="workflow-dialog-check-row-next">
              <input
                type="checkbox"
                checked={Boolean(dialog.autoImages)}
                onChange={(event) => updateShotAutoImages(event.target.checked)}
              />
              <span>
                <strong>分镜完成后自动生成图片</strong>
                <small>不勾选时，本次仅执行分镜生成；勾选后可配置图片渠道、模型和尺寸参数。</small>
              </span>
            </label>
          </div>
        ) : null}
        {usesImageModel ? (
          <div className="workflow-dialog-fields-next workflow-dialog-image-fields-next">
            <div className="workflow-control-row-next">
              <label>
                图片渠道
                <select value={dialog.imageKeyId || ""} onChange={(event) => updateImageApi(event.target.value)}>
                  <option value="">请选择图片渠道</option>
                  {imageKeys.map((key) => (
                    <option value={key.id} key={key.id}>{apiKeyDisplayName(key)}</option>
                  ))}
                </select>
              </label>
              <label>
                图片模型
                <select value={imageModelValue} onChange={(event) => updateImageModel(event.target.value)} disabled={!dialog.imageKeyId}>
                  {imageModels.length ? imageModels.map((model) => (
                    <option value={model.id} key={model.id}>{model.name}</option>
                  )) : <option value="">请先选择图片渠道</option>}
                </select>
              </label>
            </div>
            <div>
              <div className="workflow-dialog-field-label-next">图片分辨率</div>
              <div className="workflow-option-stepper-next">
                {imageResolutionOptions.length ? imageResolutionOptions.map((resolution) => (
                  <button className={imageResolutionValue === resolution ? "selected" : ""} type="button" onClick={() => updateImageField("imageResolution", resolution)} key={resolution}>{resolution}</button>
                )) : <span className="workflow-field-help-next">请先选择图片渠道和模型</span>}
              </div>
            </div>
            <div>
              <div className="workflow-dialog-field-label-next">图片比例 / 尺寸</div>
              <div className="workflow-ratio-grid-next">
                {imageRatioOptions.length ? imageRatioOptions.map((ratio) => (
                  <button className={imageRatioValue === ratio.value ? "selected" : ""} type="button" onClick={() => updateImageField("ratio", ratio.value)} key={ratio.value}>
                    {ratio.label}<small>{ratio.detail || ratio.value}</small>
                  </button>
                )) : <span className="workflow-field-help-next">请先选择图片渠道和模型</span>}
              </div>
            </div>
            {customImageSizeRequired ? (
              <label>
                自定义尺寸
                <input value={dialog.customSize || ""} onChange={(event) => updateImageField("customSize", event.target.value)} placeholder="例如 1280x1920" />
                <span className="workflow-field-help-next">宽高建议使用 16px 的倍数，最大边长不超过 3840px。</span>
              </label>
            ) : null}
          </div>
        ) : null}
        {usesAudioChoices ? (
          <div className="workflow-dialog-fields-next">
            <div className="workflow-control-row-next">
              <label>
                音频渠道
                <select value={dialog.audioKeyId || ""} onChange={(event) => updateAudioApi(event.target.value)}>
                  <option value="">请选择音频渠道</option>
                  {audioKeys.map((key) => (
                    <option value={key.id} key={key.id}>{apiKeyDisplayName(key)}</option>
                  ))}
                </select>
              </label>
              <label>
                音频模型
                <select value={audioModelValue} onChange={(event) => updateAudioField("audioModelId", event.target.value)} disabled={!dialog.audioKeyId}>
                  {audioModels.length ? audioModels.map((model) => (
                    <option value={model.id} key={model.id}>{model.name}</option>
                  )) : <option value="">请先选择音频渠道</option>}
                </select>
              </label>
            </div>
            <div className="workflow-control-row-next">
              <label>
                输出格式
                <select value={dialog.audioFormat || "mp3"} onChange={(event) => updateAudioField("audioFormat", event.target.value)}>
                  {workflowAudioFormats.map((format) => (
                    <option value={format} key={format}>{format.toUpperCase()}</option>
                  ))}
                </select>
              </label>
              <label>
                情绪
                <select value={dialog.audioEmotion || "natural"} onChange={(event) => updateAudioField("audioEmotion", event.target.value)}>
                  {workflowAudioEmotions.map((emotion) => (
                    <option value={emotion.value} key={emotion.value}>{emotion.label}</option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              语速
              <div className="workflow-slider-row-next">
                <input type="range" min="0.5" max="2" step="0.1" value={dialog.audioSpeed || 1} onChange={(event) => updateAudioField("audioSpeed", Number(event.target.value))} />
                <span>{Number(dialog.audioSpeed || 1).toFixed(1)}x</span>
              </div>
            </label>
            <div className="workflow-control-row-next">
              <label>
                音色模式
                <select value={audioVoiceMode} onChange={(event) => updateAudioField("audioVoicePresetId", event.target.value)}>
                  {workflowAudioVoiceModes.map((mode) => (
                    <option value={mode.id} key={mode.id}>{mode.name}</option>
                  ))}
                </select>
              </label>
              {audioVoiceMode !== "saved" ? (
                <label>
                  兼容音色
                  <input value={dialog.audioVoice || ""} onChange={(event) => updateAudioField("audioVoice", event.target.value)} placeholder="例如 alloy、nova，可留空" />
                </label>
              ) : null}
            </div>
            {audioVoiceMode === "saved" ? (
              <SavedAudioVoicePicker
                value={dialog.audioReferenceId || ""}
                onChange={(referenceId) => updateAudioField("audioReferenceId", referenceId)}
              />
            ) : null}
            <span className="workflow-field-help-next">
              {audioVoiceMode === "clone"
                ? `将使用工作流配置中的 ${firstWorkflowArray(dialog.audioReferences).length} 条参考音频。`
                : workflowAudioVoiceModes.find((mode) => mode.id === audioVoiceMode)?.description || "配置口播音色。"}
            </span>
            <div className="workflow-dialog-choice-list-next">
              {(Array.isArray(dialog.audioChoices) ? dialog.audioChoices : []).map((choice) => {
                const checked = Array.isArray(dialog.audioVariants) && dialog.audioVariants.includes(choice.variant);
                return (
                  <label className={`workflow-dialog-check-row-next ${choice.available ? "" : "disabled"}`} key={choice.variant}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!choice.available}
                      onChange={() => toggleAudioVariant(choice.variant)}
                    />
                    <span>
                      <strong>{choice.label}</strong>
                      <small>{choice.available ? `${choice.count} 字` : choice.emptyText}</small>
                    </span>
                  </label>
                );
              })}
              <span className="workflow-field-help-next">生成音频和上传音频会作为独立轨道保留；再次生成原文音频时会提示替换。</span>
            </div>
          </div>
        ) : null}
        <div className="workflow-dialog-actions-next">
          {!noticeOnly ? <button className="secondary-action compact" type="button" disabled={queueing} onClick={onClose}>取消</button> : null}
          <button
            className={`primary-action compact ${dialog.tone === "danger" ? "danger-confirm-next" : ""}`}
            type="button"
            disabled={queueing || disabledByModel || disabledByImageModel || disabledByOutfitVariant || disabledByAudioChoices}
            onClick={() => onConfirm({
              ...dialog,
              modelId: modelValue,
              outfitDetectionLlmKeyId: dialog.outfitDetectionLlmKeyId || "",
              outfitDetectionModelId: outfitDetectionModelValue,
              imageModelId: imageModelValue,
              imageResolution: imageResolutionValue || dialog.imageResolution || "",
              outfitImageModelId: outfitImageModelValue,
              outfitImageResolution: outfitImageResolutionValue || dialog.outfitImageResolution || "",
              outfitImageRatio: outfitImageRatioValue || dialog.outfitImageRatio || "",
              outfitImageSize: workflowImageRequestSize(outfitImageRatioValue || dialog.outfitImageRatio || ""),
              outfitImageCustomSize: dialog.outfitImageCustomSize || "",
              ratio: imageRatioValue || dialog.ratio || "",
              imageSize: workflowImageRequestSize(imageRatioValue || dialog.ratio || ""),
              customSize: dialog.customSize || "",
              audioModelId: audioModelValue,
            })}
          >
            {queueing ? "处理中" : confirmText}
          </button>
        </div>
        </section>
      </div>
    </WorkflowDialogPortal>
  );
}

function WorkflowImageRetryDialog({ dialog, imageKeys, queueing, onChange, onClose, onConfirm }) {
  const selectedKey = imageKeys.find((key) => key.id === dialog.imageKeyId);
  const imageModels = workflowImageModelOptions(selectedKey);
  const selectedModel = imageModels.find((model) => model.id === dialog.imageModelId) || imageModels[0];
  const imageModelId = selectedModel?.id || "";
  const imageResolutionOptions = selectedModel?.resolutions || [];
  const imageResolutionValue = optionValueOrFirst(imageResolutionOptions, dialog.imageResolution || "");
  const imageRatioOptions = workflowImageRatioOptions(selectedModel);
  const imageRatioValue = optionValueOrFirst(imageRatioOptions.map((ratio) => ratio.value), dialog.ratio || "");
  const customImageSizeRequired = imageRatioValue === "custom";
  const roleImageStyleId = normalizeWorkflowRoleImageStyleId(dialog.roleImageStyleId || defaultWorkflowRoleImageStyleId);
  const customRoleImageStyleRequired = Boolean(dialog.includesRoleAssets) && roleImageStyleId === "custom";

  useEffect(() => {
    if (!dialog.imageKeyId) return;
    const nextImageSize = workflowImageRequestSize(imageRatioValue);
    const patch = {};
    if (dialog.imageModelId !== imageModelId) patch.imageModelId = imageModelId;
    if (imageResolutionValue && dialog.imageResolution !== imageResolutionValue) patch.imageResolution = imageResolutionValue;
    if (imageRatioValue && dialog.ratio !== imageRatioValue) patch.ratio = imageRatioValue;
    if (dialog.imageSize !== nextImageSize) patch.imageSize = nextImageSize;
    if (!Object.keys(patch).length) return;
    onChange((current) => current ? { ...current, ...patch } : current);
  }, [dialog.imageKeyId, dialog.imageModelId, dialog.imageResolution, dialog.ratio, dialog.imageSize, imageModelId, imageResolutionValue, imageRatioValue]);

  function updateField(field, value) {
    onChange((current) => {
      if (!current) return current;
      if (field === "imageKeyId") {
        const nextKey = imageKeys.find((key) => key.id === value);
        const nextModels = workflowImageModelOptions(nextKey);
        const nextModel = nextModels.find((model) => model.id === current.imageModelId) || nextModels[0] || null;
        const nextRatios = workflowImageRatioOptions(nextModel);
        const nextRatio = optionValueOrFirst(nextRatios.map((ratio) => ratio.value), current.ratio || "");
        return {
          ...current,
          imageKeyId: value,
          imageModelId: nextModel?.id || "",
          imageResolution: optionValueOrFirst(nextModel?.resolutions || [], current.imageResolution || ""),
          ratio: nextRatio,
          imageSize: workflowImageRequestSize(nextRatio),
        };
      }
      if (field === "imageModelId") {
        const nextModel = imageModels.find((model) => model.id === value) || imageModels[0] || null;
        const nextRatios = workflowImageRatioOptions(nextModel);
        const nextRatio = optionValueOrFirst(nextRatios.map((ratio) => ratio.value), current.ratio || "");
        return {
          ...current,
          imageModelId: nextModel?.id || "",
          imageResolution: optionValueOrFirst(nextModel?.resolutions || [], current.imageResolution || ""),
          ratio: nextRatio,
          imageSize: workflowImageRequestSize(nextRatio),
        };
      }
      if (field === "ratio") {
        return {
          ...current,
          ratio: value,
          imageSize: workflowImageRequestSize(value),
        };
      }
      return { ...current, [field]: value };
    });
  }
  const confirmDisabled = queueing
    || !dialog.imageKeyId
    || !imageModelId
    || !imageResolutionValue
    || !imageRatioValue
    || (customRoleImageStyleRequired && !String(dialog.roleImageCustomStylePrompt || "").trim())
    || (customImageSizeRequired && !String(dialog.customSize || "").trim());

  return (
    <WorkflowDialogPortal>
      <div className="workflow-image-dialog-backdrop-next" role="presentation" onClick={onClose}>
        <section className="workflow-image-retry-dialog-next workflow-image-retry-compact-next" role="dialog" aria-modal="true" aria-label={dialog.title} onClick={(event) => event.stopPropagation()}>
          <button className="workflow-dialog-close-next" type="button" onClick={onClose}>×</button>
          <div className="workflow-dialog-title-next">
            <span>RETRY</span>
            <h3>{dialog.title}</h3>
            <p>{dialog.summary}</p>
          </div>
          <article className="workflow-dialog-step-next">
            <span>重试步骤</span>
            <strong>图片生成</strong>
            <p>{dialog.hint}</p>
          </article>
          <div className="workflow-dialog-fields-next">
            <div className="workflow-control-row-next">
              <label>
                图片渠道
                <select value={dialog.imageKeyId || ""} onChange={(event) => updateField("imageKeyId", event.target.value)}>
                  <option value="">请选择图片渠道</option>
                  {imageKeys.map((key) => (
                    <option value={key.id} key={key.id}>{apiKeyDisplayName(key)}</option>
                  ))}
                </select>
              </label>
              <label>
                图片模型
                <select value={imageModelId} onChange={(event) => updateField("imageModelId", event.target.value)} disabled={!dialog.imageKeyId}>
                  {imageModels.length ? imageModels.map((model) => (
                    <option value={model.id} key={model.id}>{model.name}</option>
                  )) : <option value="">请先选择图片渠道</option>}
                </select>
              </label>
            </div>
            <div>
              <div className="workflow-dialog-field-label-next">图片分辨率</div>
              <div className="workflow-option-stepper-next">
                {imageResolutionOptions.length ? imageResolutionOptions.map((resolution) => (
                  <button className={imageResolutionValue === resolution ? "selected" : ""} type="button" onClick={() => updateField("imageResolution", resolution)} key={resolution}>{resolution}</button>
                )) : <span className="workflow-field-help-next">请先选择图片渠道和模型</span>}
              </div>
            </div>
            <div>
              <div className="workflow-dialog-field-label-next">图片比例 / 尺寸</div>
              <div className="workflow-ratio-grid-next">
                {imageRatioOptions.length ? imageRatioOptions.map((ratio) => (
                  <button className={imageRatioValue === ratio.value ? "selected" : ""} type="button" onClick={() => updateField("ratio", ratio.value)} key={ratio.value}>
                    {ratio.label}<small>{ratio.detail || ratio.value}</small>
                  </button>
                )) : <span className="workflow-field-help-next">请先选择图片渠道和模型</span>}
              </div>
            </div>
            {customImageSizeRequired ? (
              <label>
                自定义尺寸
                <input value={dialog.customSize || ""} onChange={(event) => updateField("customSize", event.target.value)} placeholder="例如 1280x1920" />
                <span className="workflow-field-help-next">宽高建议使用 16px 的倍数，最大边长不超过 3840px。</span>
              </label>
            ) : null}
            {dialog.includesRoleAssets ? (
              <div>
                <div className="workflow-dialog-field-label-next">角色图片风格</div>
                <div className="workflow-role-image-style-grid-next">
                  {workflowRoleImageStyleOptions.map((option) => (
                    <button
                      className={roleImageStyleId === option.id ? "selected" : ""}
                      type="button"
                      onClick={() => updateField("roleImageStyleId", option.id)}
                      key={option.id}
                    >
                      <strong>{option.title}</strong>
                      <small>{option.desc}</small>
                    </button>
                  ))}
                </div>
                {roleImageStyleId === "custom" ? (
                  <label className="workflow-role-image-custom-style-next">
                    自定义角色图片风格
                    <textarea
                      value={dialog.roleImageCustomStylePrompt || ""}
                      onChange={(event) => updateField("roleImageCustomStylePrompt", event.target.value)}
                      rows={3}
                      placeholder="例如：复古港片定妆照，暖色胶片质感，半身构图"
                    />
                  </label>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="workflow-dialog-actions-next">
            <button className="secondary-action compact" type="button" onClick={onClose}>取消</button>
            <button
              className="primary-action compact"
              type="button"
              disabled={confirmDisabled}
              onClick={() => onConfirm({
                ...dialog,
                imageModelId,
                imageResolution: imageResolutionValue || dialog.imageResolution || "",
                ratio: imageRatioValue || dialog.ratio || "",
                imageSize: workflowImageRequestSize(imageRatioValue || dialog.ratio || ""),
                customSize: dialog.customSize || "",
                roleImageStyleId,
                roleImageCustomStylePrompt: dialog.roleImageCustomStylePrompt || "",
              })}
            >
              {queueing ? "提交中" : "确认生成"}
            </button>
          </div>
        </section>
      </div>
    </WorkflowDialogPortal>
  );
}

function WorkflowManualOutfitDialog({ dialog, roles = [], shots = [], saving, matching, llmKeys = [], onChange, onClose, onAutoMatch, onConfirm }) {
  const selectedShotSet = new Set((Array.isArray(dialog.shotRefs) ? dialog.shotRefs : []).map(Number).filter(Boolean));
  const disabled = saving || !dialog.roleAssetRef || !stringFromWorkflowValue(dialog.variantName).trim() || !stringFromWorkflowValue(dialog.outfitPrompt).trim() || !selectedShotSet.size;
  const selectedLlmKey = llmKeys.find((key) => key.id === dialog.autoMatchLlmKeyId) || null;
  const autoMatchModels = workflowLlmModelOptions(selectedLlmKey);
  const autoMatchModelId = autoMatchModels.some((model) => model.id === dialog.autoMatchModelId) ? dialog.autoMatchModelId : autoMatchModels[0]?.id || "";

  function updateField(field, value) {
    onChange((current) => current ? { ...current, [field]: value } : current);
  }

  function updateAutoMatchLlmKey(autoMatchLlmKeyId) {
    const key = llmKeys.find((item) => item.id === autoMatchLlmKeyId) || null;
    const models = workflowLlmModelOptions(key);
    onChange((current) => current ? {
      ...current,
      autoMatchLlmKeyId,
      autoMatchModelId: models[0]?.id || "",
    } : current);
  }

  function toggleShot(shotIndex) {
    const index = Number(shotIndex);
    if (!Number.isFinite(index) || index <= 0) return;
    onChange((current) => {
      if (!current) return current;
      const currentSet = new Set((Array.isArray(current.shotRefs) ? current.shotRefs : []).map(Number).filter(Boolean));
      if (currentSet.has(index)) currentSet.delete(index);
      else currentSet.add(index);
      return {
        ...current,
        shotRefs: [...currentSet].sort((left, right) => left - right),
      };
    });
  }

  return (
    <WorkflowDialogPortal>
      <div className="workflow-image-dialog-backdrop-next" role="presentation" onClick={onClose}>
        <section className="workflow-image-retry-dialog-next workflow-manual-outfit-dialog-next" role="dialog" aria-modal="true" aria-label="添加变装版本" onClick={(event) => event.stopPropagation()}>
          <button className="workflow-dialog-close-next" type="button" onClick={onClose}>×</button>
          <div className="workflow-dialog-title-next">
            <span>OUTFIT</span>
            <h3>添加变装版本</h3>
            <p>创建当前任务专用角色版本，并把选中的镜头改为引用这张角色图。</p>
          </div>
          <div className="workflow-dialog-fields-next">
            <label>
              基础角色
              <select value={dialog.roleAssetRef || ""} onChange={(event) => updateField("roleAssetRef", event.target.value)}>
                {roles.map((role) => (
                  <option value={role.assetRef} key={role.assetRef}>{role.title || role.assetRef}</option>
                ))}
              </select>
            </label>
            <label>
              版本名
              <input value={dialog.variantName || ""} onChange={(event) => updateField("variantName", event.target.value)} placeholder="例如：落魄装穷版" />
            </label>
          </div>
          <label className="workflow-manual-outfit-field-next">
            变装描述
            <textarea
              value={dialog.outfitPrompt || ""}
              onChange={(event) => updateField("outfitPrompt", event.target.value)}
              rows={5}
              placeholder="只写服装、年龄阶段或视觉状态变化；人物五官、发型和身材会沿用基础角色。"
            />
          </label>
          <div className="workflow-manual-outfit-shot-picker-next">
            <div>
              <b>适用镜头</b>
              <span>{selectedShotSet.size ? `已选择 ${selectedShotSet.size} 个镜头` : "请选择至少 1 个镜头"}</span>
            </div>
            <div className="workflow-manual-outfit-mode-next" role="group" aria-label="适用镜头选择方式">
              <button className={(dialog.matchMode || "manual") === "manual" ? "selected" : ""} type="button" onClick={() => updateField("matchMode", "manual")}>
                手动勾选
              </button>
              <button className={dialog.matchMode === "auto" ? "selected" : ""} type="button" onClick={() => updateField("matchMode", "auto")}>
                AI 自动匹配
              </button>
            </div>
            {dialog.matchMode === "auto" ? (
              <div className="workflow-manual-outfit-auto-next">
                <div className="workflow-control-row-next">
                  <label>
                    检测 LLM 渠道
                    <select value={dialog.autoMatchLlmKeyId || ""} onChange={(event) => updateAutoMatchLlmKey(event.target.value)}>
                      <option value="">请选择 LLM 渠道</option>
                      {llmKeys.map((key) => (
                        <option value={key.id} key={key.id}>{apiKeyDisplayName(key)}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    检测 LLM 模型
                    <select value={autoMatchModelId} onChange={(event) => updateField("autoMatchModelId", event.target.value)} disabled={!dialog.autoMatchLlmKeyId}>
                      {autoMatchModels.length ? autoMatchModels.map((model) => (
                        <option value={model.id} key={model.id}>{model.name}</option>
                      )) : <option value="">请先选择 LLM 渠道</option>}
                    </select>
                  </label>
                </div>
                <button
                  className="secondary-action compact"
                  type="button"
                  disabled={matching || saving || !dialog.roleAssetRef || !dialog.variantName || !dialog.outfitPrompt || !dialog.autoMatchLlmKeyId || !autoMatchModelId}
                  onClick={() => onAutoMatch?.({ ...dialog, autoMatchModelId })}
                >
                  {matching ? "匹配中..." : "AI 匹配镜头"}
                </button>
              </div>
            ) : null}
            {shots.length ? (
              <div className="workflow-manual-outfit-shot-list-next">
                {shots.map((shot) => (
                  <label className={selectedShotSet.has(shot.index) ? "selected" : ""} key={shot.index}>
                    <input type="checkbox" checked={selectedShotSet.has(shot.index)} onChange={() => toggleShot(shot.index)} />
                    <span>
                      <strong>第 {shot.index} 镜</strong>
                      <small>{shot.title || shot.text || "未解析到镜头内容"}</small>
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <p className="workflow-run-danger-text-next">没有解析到可选择的分镜镜头。</p>
            )}
          </div>
          <div className="workflow-dialog-actions-next">
            <button className="secondary-action compact" type="button" disabled={saving} onClick={onClose}>取消</button>
            <button className="primary-action compact" type="button" disabled={disabled} onClick={() => onConfirm(dialog)}>
              {saving ? "添加中" : "添加版本"}
            </button>
          </div>
        </section>
      </div>
    </WorkflowDialogPortal>
  );
}

function ShotImageCard({ run, shot, index, selectionActive, selected, savingPrompt, uploadingProductImage, uploadingRoleImage, watermarking, restoringWatermark, ecommerce = false, onToggleShot, onPreviewImage, onRegenerateImage, onOpenManualOutfitVariant, onSaveImagePrompt, onUploadProductImage, onUploadRoleImage, onOpenRoleWatermarkDialog, onRemoveRoleNameWatermark, onDeleteImage }) {
  const imageUrl = workflowShotImageUrl(shot);
  const thumbnailUrl = workflowShotThumbnailUrl(shot) || workflowImagePreviewUrl(imageUrl);
  const shotNumber = workflowShotNumber(shot, index);
  const status = workflowShotStatus(shot, imageUrl, run);
  const ecommerceRole = ecommerce && shot.assetType === "role";
  const ecommerceScene = ecommerce && shot.assetType === "scene";
  const ecommerceProduct = ecommerce && shot.assetType === "product";
  const watermarkEligible = ecommerceRole || ecommerceScene;
  const imageGenerationActive = workflowNodeIsRunning(run, "image") || status === "生成中";
  const watermarkApplied = watermarkEligible && workflowRoleNameWatermarkApplied(shot, imageUrl);
  const watermarkRestorable = watermarkEligible && workflowRoleNameWatermarkRestorable(shot);
  const displayShotTitle = ecommerceScene ? cleanEcommerceAssetDisplayTitle(shot.title) : shot.title;
  const title = ecommerce && shot.assetType === "role"
    ? `角色图 · ${displayShotTitle || shot.roleKey || shotNumber}`
    : ecommerce && shot.assetType === "scene"
      ? `场景图 · ${displayShotTitle || shotNumber}`
      : ecommerce && shot.assetType === "product"
        ? `商品图 · ${displayShotTitle || shotNumber}`
      : `镜头 ${shotNumber}`;
  const prompt = stringFromWorkflowValue(shot.imagePrompt || shot.prompt || shot.description) || "暂无图片提示词";
  const promptLabel = ecommerce && shot.assetType === "role" ? "角色外观描述" : ecommerce && shot.assetType === "scene" ? "场景提示词" : ecommerce && shot.assetType === "product" ? "商品信息" : "图片提示词";
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [promptDraft, setPromptDraft] = useState(prompt);
  const productUploadInputRef = useRef(null);
  const roleUploadInputRef = useRef(null);

  useEffect(() => {
    if (!editingPrompt) setPromptDraft(prompt);
  }, [editingPrompt, prompt]);

  async function handleSavePrompt(event) {
    event.stopPropagation();
    await onSaveImagePrompt?.(shot, promptDraft);
    setEditingPrompt(false);
  }

  function handleProductImageInput(event) {
    const files = event.target.files;
    onUploadProductImage?.(shot, files);
    event.target.value = "";
  }

  function handleRoleImageInput(event) {
    const files = event.target.files;
    onUploadRoleImage?.(shot, files);
    event.target.value = "";
  }

  return (
    <article className={`${selectionActive && imageUrl ? "selectable" : ""} ${selected ? "selected" : ""} ${ecommerce ? "ecommerce-image-card-next" : ""} ${ecommerceRole ? "role" : ""} ${ecommerceScene ? "scene" : ""} ${ecommerceProduct ? "product" : ""}`} onClick={() => onToggleShot(shot)}>
      {imageUrl ? (
        <div className="workflow-shot-image-preview-next">
          <img src={thumbnailUrl} alt={displayShotTitle || `${title} 图片`} loading="lazy" decoding="async" />
          {selectionActive ? <span className="workflow-shot-image-check-next">{selected ? "✓" : ""}</span> : null}
          <div className="workflow-shot-image-overlay-next">
            <div className="workflow-shot-image-actions-next">
              <button className="workflow-shot-overlay-action-next preview" type="button" onClick={(event) => {
                event.stopPropagation();
                onPreviewImage({ url: imageUrl, title, alt: displayShotTitle || `${title} 图片` });
              }}>
                <span>⌕</span>
                预览
              </button>
              {!ecommerceProduct ? (
                <>
                {watermarkEligible ? (
                  watermarkApplied && watermarkRestorable ? (
                    <button className="workflow-shot-overlay-action-next watermark" type="button" disabled={imageGenerationActive || restoringWatermark || watermarking} onClick={(event) => {
                      event.stopPropagation();
                      onRemoveRoleNameWatermark?.([workflowShotId(shot)]);
                    }}>
                      <span aria-hidden="true">↩</span>
                      {restoringWatermark ? "取消中" : "取消水印"}
                    </button>
                  ) : (
                    <button className="workflow-shot-overlay-action-next watermark" type="button" disabled={imageGenerationActive || watermarking || restoringWatermark} onClick={(event) => {
                      event.stopPropagation();
                      onOpenRoleWatermarkDialog?.([workflowShotId(shot)], ecommerceScene ? "scene" : "role");
                    }}>
                      <span aria-hidden="true">◫</span>
                      {watermarking ? "处理中" : "加水印"}
                    </button>
                  )
                ) : null}
                {ecommerceRole && !imageGenerationActive ? (
                  <>
                    <button className="workflow-shot-overlay-action-next upload" type="button" disabled={uploadingRoleImage} onClick={(event) => {
                      event.stopPropagation();
                      roleUploadInputRef.current?.click();
                    }}>
                      <span>↑</span>
                      {uploadingRoleImage ? "上传中" : "本地上传"}
                    </button>
                    <input ref={roleUploadInputRef} type="file" accept="image/*" hidden onChange={handleRoleImageInput} />
                  </>
                ) : null}
                <button className="workflow-shot-overlay-action-next regenerate" type="button" disabled={imageGenerationActive} onClick={(event) => {
                  event.stopPropagation();
                  onRegenerateImage(shot);
                }}>
                  <span>↻</span>
                  重生
                </button>
                <button className="workflow-shot-overlay-action-next danger" type="button" disabled={imageGenerationActive} onClick={(event) => {
                  event.stopPropagation();
                  onDeleteImage(shot);
                }}>
                  <span>×</span>
                  删除
                </button>
                </>
              ) : null}
            </div>
          </div>
        </div>
      ) : (
        <div className={`workflow-shot-image-placeholder-next ${status === "生成失败" ? "error" : status === "等待已暂停" ? "paused" : ""}`}>
          <span>{shotNumber}</span>
          <b>{shot.imageError || shot.imagePauseReason || status}</b>
          {ecommerceProduct ? (
            <>
              <button className="workflow-product-image-upload-action-next" type="button" disabled={uploadingProductImage} onClick={(event) => {
                event.stopPropagation();
                productUploadInputRef.current?.click();
              }}>
                {uploadingProductImage ? "上传中..." : "上传商品图"}
              </button>
              <input ref={productUploadInputRef} type="file" accept="image/*" hidden onChange={handleProductImageInput} />
            </>
          ) : ecommerceRole && !imageGenerationActive ? (
            <>
              <button className="workflow-product-image-upload-action-next" type="button" disabled={uploadingRoleImage} onClick={(event) => {
                event.stopPropagation();
                roleUploadInputRef.current?.click();
              }}>
                {uploadingRoleImage ? "上传中..." : "上传本地角色图"}
              </button>
              <input ref={roleUploadInputRef} type="file" accept="image/*" hidden onChange={handleRoleImageInput} />
            </>
          ) : null}
        </div>
      )}
      {ecommerce ? (
        <EcommerceImageCardInfo
          shot={shot}
          title={title}
          status={status}
          prompt={prompt}
          promptLabel={promptLabel}
          onOpenManualOutfitVariant={onOpenManualOutfitVariant}
          editingPrompt={editingPrompt}
          promptDraft={promptDraft}
          savingPrompt={savingPrompt}
          onEditPrompt={() => setEditingPrompt(true)}
          onChangePrompt={setPromptDraft}
          onCancelPrompt={(event) => {
            event.stopPropagation();
            setPromptDraft(prompt);
            setEditingPrompt(false);
          }}
          onSavePrompt={handleSavePrompt}
        />
      ) : (
        <>
          <div className="workflow-shot-image-meta-next">
            <strong>{title}</strong>
            <span>{status}</span>
          </div>
          <div className="workflow-shot-image-prompt-next" onClick={(event) => event.stopPropagation()}>
            <div className="workflow-video-prompt-head-next">
              <b>{promptLabel}</b>
              {!editingPrompt ? (
                <button className="workflow-video-prompt-edit-next" type="button" onClick={() => setEditingPrompt(true)} aria-label={`编辑 ${title} 图片提示词`}>
                  ✎
                </button>
              ) : null}
            </div>
            {editingPrompt ? (
              <div className="workflow-video-prompt-editor-next">
                <textarea
                  value={promptDraft}
                  onChange={(event) => setPromptDraft(event.target.value)}
                  rows={5}
                  placeholder="输入这个镜头的图片提示词"
                />
                <div className="workflow-video-prompt-actions-next">
                  <button className="secondary-action compact" type="button" disabled={savingPrompt} onClick={(event) => {
                    event.stopPropagation();
                    setPromptDraft(prompt);
                    setEditingPrompt(false);
                  }}>
                    取消
                  </button>
                  <button className="primary-action compact" type="button" disabled={savingPrompt || !promptDraft.trim()} onClick={handleSavePrompt}>
                    {savingPrompt ? "保存中" : "保存"}
                  </button>
                </div>
              </div>
            ) : (
              <p>{prompt}</p>
            )}
          </div>
        </>
      )}
    </article>
  );
}

function EcommerceImageCardInfo({ shot, title, status, prompt, promptLabel, onOpenManualOutfitVariant, editingPrompt, promptDraft, savingPrompt, onEditPrompt, onChangePrompt, onCancelPrompt, onSavePrompt }) {
  const isScene = shot.assetType === "scene";
  const isRole = shot.assetType === "role";
  const isProduct = shot.assetType === "product";
  const displayTitle = isScene ? cleanEcommerceAssetDisplayTitle(shot.title || title) : shot.title || title;
  const mappingShots = isScene ? ecommerceSceneMappingShotLabels(shot.sceneMapping) : [];
  const previewShots = mappingShots.slice(0, 8);
  const remainingCount = Math.max(mappingShots.length - previewShots.length, 0);
  const sourceLabel = workflowEcommerceImageSourceLabel(shot, status);
  const outfitVariant = isRole && workflowShotIsOutfitVariant(shot);
  const [mappingExpanded, setMappingExpanded] = useState(false);
  return (
    <div className="workflow-ecommerce-image-info-next" onClick={(event) => event.stopPropagation()}>
      <div className="workflow-ecommerce-image-title-next">
        <div>
          <span>{isRole ? "角色资产" : isScene ? "场景资产" : isProduct ? "商品资产" : "图片资产"}</span>
          <strong>{displayTitle}</strong>
        </div>
        <b>{status}</b>
      </div>
      {isScene ? (
        <div className="workflow-ecommerce-scene-map-next">
          <div className="workflow-ecommerce-scene-map-head-next">
            <span>映射镜头</span>
            <strong>{mappingShots.length ? `${mappingShots.length} 个镜头` : "未填写"}</strong>
          </div>
          {!mappingExpanded && previewShots.length ? (
            <div className="workflow-ecommerce-shot-chip-row-next">
              {previewShots.map((item) => <span key={item}>{item}</span>)}
              {remainingCount ? <span className="more">+{remainingCount}</span> : null}
            </div>
          ) : !mappingShots.length ? (
            <p>{stringFromWorkflowValue(shot.sceneMapping) || "暂无镜头映射"}</p>
          ) : null}
          {mappingShots.length > previewShots.length ? (
            <details className="workflow-ecommerce-map-details-next" open={mappingExpanded} onToggle={(event) => setMappingExpanded(event.currentTarget.open)}>
              <summary>全部镜头</summary>
              <div className="workflow-ecommerce-shot-chip-row-next expanded">
                {mappingShots.map((item) => <span key={item}>{item}</span>)}
              </div>
            </details>
          ) : null}
        </div>
      ) : (
        <>
          <div className="workflow-ecommerce-role-source-next">
            <span>{sourceLabel}</span>
            <b>{isProduct ? "Product" : shot.roleKey || "Role"}</b>
          </div>
          {isRole && !outfitVariant ? (
            <button className="workflow-ecommerce-role-mini-action-next" type="button" onClick={(event) => { event.stopPropagation(); onOpenManualOutfitVariant?.(shot); }}>
              添加变装版本
            </button>
          ) : null}
          {outfitVariant ? (
            <div className={`workflow-ecommerce-outfit-asset-status-next ${workflowOutfitVariantTone(workflowOutfitVariantStatusFromShot(shot, status))}`}>
              <strong>变装补齐</strong>
              <span>{status}</span>
            </div>
          ) : null}
        </>
      )}
      <div className="workflow-ecommerce-prompt-panel-next">
        <div className="workflow-video-prompt-head-next">
          <b>{promptLabel}</b>
          {!editingPrompt ? (
            <button className="workflow-video-prompt-edit-next" type="button" onClick={onEditPrompt} aria-label={`编辑 ${title} 图片提示词`}>
              ✎
            </button>
          ) : null}
        </div>
        {editingPrompt ? (
          <div className="workflow-video-prompt-editor-next">
            <textarea
              value={promptDraft}
              onChange={(event) => onChangePrompt(event.target.value)}
              rows={5}
              placeholder="输入这个图片资产的提示词"
            />
            <div className="workflow-video-prompt-actions-next">
              <button className="secondary-action compact" type="button" disabled={savingPrompt} onClick={onCancelPrompt}>
                取消
              </button>
              <button className="primary-action compact" type="button" disabled={savingPrompt || !promptDraft.trim()} onClick={onSavePrompt}>
                {savingPrompt ? "保存中" : "保存"}
              </button>
            </div>
          </div>
        ) : (
          <details className="workflow-ecommerce-prompt-details-next">
            <summary>查看提示词</summary>
            <p>{prompt}</p>
          </details>
        )}
      </div>
    </div>
  );
}

function TimelineSegmentCard({ item, index, editing, draft, saving, generating, onEdit, onGenerate, onCopy, onDelete, onDeleteAsset, onChangeDraft, onCancel, onSave }) {
  const assets = workflowVideoSegmentAssets(item);
  const prompt = stringFromWorkflowValue(item.videoPrompt);
  const segmentLabel = workflowVideoSegmentLabel(item, index);
  const stopSummaryAction = (event, action) => {
    event.preventDefault();
    event.stopPropagation();
    action?.();
  };
  return (
    <article>
      <div>
        <div className="workflow-shot-card-head-next">
          <strong>{item.title || item.shotTitle || segmentLabel}</strong>
          <div className="workflow-video-segment-head-actions-next">
            <span>{assets.length ? `${assets.length} 项资料` : "暂无图片"}</span>
            <button className="workflow-video-segment-delete-next" type="button" onClick={onDelete} aria-label={`删除 ${segmentLabel}`} title="删除镜头">
              ×
            </button>
          </div>
        </div>
        {assets.length ? (
          <div className="workflow-video-assets-next">
            {assets.map((asset, assetIndex) => (
              <figure key={asset.imageUrl || `${asset.index}-${assetIndex}`}>
                <img src={asset.thumbnailUrl || asset.imageUrl} alt={`视频片段 ${index + 1} 图片 ${assetIndex + 1}`} loading="lazy" decoding="async" />
                <button
                  className="workflow-video-asset-delete-next"
                  type="button"
                  onClick={() => onDeleteAsset?.(asset, assetIndex)}
                  aria-label={`删除 ${workflowVideoAssetDisplayName(asset, assetIndex)}`}
                  title="删除图片"
                >
                  ×
                </button>
                <figcaption>{workflowVideoAssetDisplayName(asset, assetIndex)}</figcaption>
              </figure>
            ))}
          </div>
        ) : null}
        <div className="workflow-shot-field-next">
          {editing ? (
            <div className="workflow-video-prompt-editor-next">
              <div className="workflow-video-prompt-head-next">
                <b>视频提示词</b>
              </div>
              <textarea
                value={draft}
                onChange={(event) => onChangeDraft(event.target.value)}
                rows={6}
                placeholder="输入这个片段的视频提示词"
              />
              <div className="workflow-video-prompt-actions-next">
                <button className="secondary-action compact" type="button" disabled={saving} onClick={onCancel}>
                  取消
                </button>
                <button className="primary-action compact" type="button" disabled={saving} onClick={onSave}>
                  {saving ? "保存中" : "保存"}
                </button>
              </div>
            </div>
          ) : (
            <details className="workflow-video-prompt-details-next">
              <summary>
                <span>视频提示词</span>
                <span className="workflow-video-prompt-summary-actions-next">
                  <button className="workflow-video-generate-next" type="button" disabled={generating || !assets.length} onClick={(event) => stopSummaryAction(event, onGenerate)} aria-label={`生成 ${segmentLabel} 视频`} title="生成视频">
                    {generating ? "…" : "▶"}
                  </button>
                  <button className="workflow-video-prompt-edit-next" type="button" onClick={(event) => stopSummaryAction(event, onEdit)} aria-label={`编辑 ${segmentLabel} 视频提示词`} title="编辑提示词">
                    ✎
                  </button>
                  <button className="workflow-video-prompt-copy-next" type="button" disabled={!prompt} onClick={(event) => stopSummaryAction(event, onCopy)} aria-label={`复制 ${segmentLabel} 视频提示词`} title="复制提示词">
                    ⧉
                  </button>
                  <i aria-hidden="true" />
                </span>
              </summary>
              {prompt ? <pre>{prompt}</pre> : <p>暂无视频提示词</p>}
            </details>
          )}
        </div>
      </div>
    </article>
  );
}

function VideoResultCard({ video, index, selected, querying, onToggleSelected, onDelete, onQuery, onRecoverTaskId, onResume }) {
  const [recoveryTaskId, setRecoveryTaskId] = useState("");
  const videoUrl = workflowVideoUrl(video);
  const title = workflowVideoTitle(video, index);
  const description = workflowVideoDescription(video);
  const prompt = stringFromWorkflowValue(video?.prompt).trim();
  const status = workflowVideoResultStatus(video);
  const statusLabel = workflowVideoResultStatusLabel(video);
  const taskId = stringFromWorkflowValue(video?.taskId || video?.meta?.taskId);
  const upstreamStatus = stringFromWorkflowValue(video?.upstreamStatus || video?.providerStatus);
  const lastSyncedAt = stringFromWorkflowValue(video?.lastQueriedAt || video?.lastSyncedAt || video?.submittedAt);
  const latestQueryError = stringFromWorkflowValue(video?.recentQueryError || video?.queryError);
  const failed = workflowVideoStatusIsFailed(status);
  const pausedQueued = workflowVideoResultIsPausedQueued(video);
  const canQuery = Boolean(taskId && !videoUrl);
  const canRecoverTaskId = Boolean(!taskId && workflowVideoResultIsSubmissionUnknown(video) && !videoUrl);
  const recoveryTaskIdValue = recoveryTaskId.trim();
  return (
    <article className={selected ? "selected" : ""}>
      <label className="workflow-video-result-select-next">
        <input type="checkbox" checked={selected} onChange={onToggleSelected} />
        <span>选择</span>
      </label>
      {videoUrl ? (
        <div className="workflow-video-placeholder-next success">
          <span className="workflow-video-status-icon-next success">✓</span>
          <strong>视频已完成</strong>
          <small>已生成视频文件，可打开、单独下载或加入下载任务。</small>
        </div>
      ) : (
        <div className={`workflow-video-placeholder-next ${workflowVideoResultStatusTone(video)}`}>
          <span className={`workflow-video-status-icon-next ${workflowVideoResultStatusTone(video)}`}>
            {workflowVideoStatusIsFailed(status) ? "!" : workflowVideoStatusIsQueued(status) ? "⏳" : "▶"}
          </span>
          <strong>{statusLabel}</strong>
          <small>{workflowVideoStatusMessage(video)}</small>
        </div>
      )}
      <div className="workflow-video-result-meta-next">
        <div className="workflow-video-result-status-row-next">
          <strong>{title}</strong>
          <span className={`workflow-video-status-pill-next ${workflowVideoResultStatusTone(video)}`}>{statusLabel}</span>
        </div>
        {description ? <p>{description}</p> : null}
        {prompt ? (
          <details className="workflow-video-result-prompt-next">
            <summary>查看提示词</summary>
            <p>{prompt}</p>
          </details>
        ) : null}
        {taskId ? <code>任务编号：{taskId}</code> : null}
        {upstreamStatus ? <code>上游状态：{upstreamStatus}</code> : null}
        {lastSyncedAt ? <code>最近同步：{formatWorkflowDateTime(lastSyncedAt)}</code> : null}
        {latestQueryError ? <code>最近查询失败：{latestQueryError}</code> : null}
        {canRecoverTaskId ? (
          <div className="workflow-video-recovery-next">
            <input
              value={recoveryTaskId}
              onChange={(event) => setRecoveryTaskId(event.target.value)}
              placeholder="粘贴上游 task_id"
              disabled={querying}
            />
            <button className="secondary-action compact" type="button" disabled={!recoveryTaskIdValue || querying} onClick={() => onRecoverTaskId?.(recoveryTaskIdValue)}>
              {querying ? "查询中..." : "关联并查询"}
            </button>
          </div>
        ) : null}
        {video?.modelName || video?.duration || video?.ratio ? (
          <div className="workflow-video-result-tags-next">
            {video.modelName ? <span>{video.modelName}</span> : null}
            {video.ratio ? <span>{video.ratio}</span> : null}
            {video.duration ? <span>{video.duration}</span> : null}
          </div>
        ) : null}
        <div className="workflow-video-link-row-next">
          {videoUrl ? (
            <>
            <a className="secondary-action compact" href={videoUrl} target="_blank" rel="noreferrer">
              打开视频
            </a>
            <a className="secondary-action compact" href={videoUrl} download={safeWorkflowFileName(title)}>
              下载视频
            </a>
            </>
          ) : null}
          {!videoUrl && pausedQueued ? (
            <button className="secondary-action compact" type="button" onClick={onResume}>
              继续提交
            </button>
          ) : null}
          {!videoUrl && !canRecoverTaskId && !pausedQueued ? (
            <button className="secondary-action compact" type="button" disabled={!canQuery || querying} onClick={onQuery}>
              {!taskId ? "等待提交" : querying ? "查询中..." : failed ? "查询结果" : "查询状态"}
            </button>
          ) : null}
          <button className="secondary-action compact danger-soft-next" type="button" onClick={onDelete}>
            删除任务
          </button>
        </div>
      </div>
    </article>
  );
}

function normalizeWorkflowConfig(workflow) {
  const config = workflow?.config && typeof workflow.config === "object" ? workflow.config : {};
  const ratio = config.ratio || workflow?.ratio || "9:16";
  return {
    ...config,
    id: workflow?.id || config.id || "",
    name: workflow?.name || config.name || "未命名工作流",
    type: workflow?.type || config.type || "explain",
    ratio,
    imageSize: config.imageSize || workflowImageRequestSize(ratio),
    createdAt: workflow?.createdAt || config.createdAt || "",
    updatedAt: workflow?.updatedAt || config.updatedAt || "",
  };
}

function normalizeWorkflowConfigForRun(workflow, run) {
  const snapshot = workflowSnapshotFromRun(run);
  if (!Object.keys(snapshot).length) return normalizeWorkflowConfig(workflow);
  return normalizeWorkflowConfig({
    ...workflow,
    ...snapshot,
    config: snapshot,
  });
}

function workflowSnapshotFromRun(run = {}) {
  return objectFromWorkflowValue(run?.workflowSnapshot || run?.workflowConfig || run?.result?.workflowSnapshot || run?.result?.workflowConfig);
}

function normalizeWorkflowVisualStyles(assets = []) {
  return assets
    .map((asset) => {
      const payload = asset?.payload && typeof asset.payload === "object" ? asset.payload : {};
      return {
        id: asset?.id || payload.id || "",
        name: asset?.name || payload.name || "未命名图风",
        prompt: payload.prompt || asset?.prompt || payload.content || payload.text || "",
        desc: payload.desc || asset?.desc || "",
      };
    })
    .filter((style) => style.id || style.name || style.prompt);
}

function normalizeWorkflowMusicAssets(assets = []) {
  return (Array.isArray(assets) ? assets : []).map((asset) => {
    const payload = objectFromWorkflowValue(asset?.payload);
    return {
      id: String(asset?.id || payload.id || ""),
      name: stringFromWorkflowValue(asset?.name || payload.name) || "未命名音频",
      fileUrl: resolveFlowStudioFileUrl(asset?.fileUrl || payload.fileUrl || payload.dataUrl || payload.url || ""),
      duration: Number(asset?.duration || payload.duration || payload.audioDuration || 0),
    };
  }).filter((asset) => asset.id && asset.fileUrl);
}

function workflowVisualStylePayload(workflow, visualStyles = [], override = {}) {
  const visualStyleId = override.visualStyleId || workflow?.visualStyleId || "";
  const visualStyle = visualStyles.find((style) => style.id === visualStyleId || style.name === visualStyleId);
  const visualStyleName = override.visualStyleName || workflow?.visualStyleName || visualStyle?.name || "";
  const visualStylePrompt = override.visualStylePrompt || workflow?.visualStylePrompt || visualStyle?.prompt || "";
  return {
    visualStyleId,
    visualStyleName,
    visualStylePrompt,
  };
}

async function workflowProductAssetForShot(workflow = {}, shot = {}) {
  const snapshotAsset = workflowProductAssetSnapshotForShot(workflow, shot);
  const assetId = workflowProductAssetId(shot, snapshotAsset);
  if (!assetId) return snapshotAsset;
  try {
    const result = await listAssets("product");
    const assets = Array.isArray(result.assets) ? result.assets.map(normalizeWorkflowProductAsset) : [];
    return assets.find((asset) => asset.id === assetId) || snapshotAsset;
  } catch {
    return snapshotAsset;
  }
}

function workflowProductAssetSnapshotForShot(workflow = {}, shot = {}) {
  const products = workflowProductAssetsFromConfig(workflow);
  if (!products.length) return null;
  const assetId = stringFromWorkflowValue(shot.productAssetId || shot.assetId);
  if (assetId) {
    const matched = products.find((asset) => workflowProductAssetId({}, asset) === assetId);
    if (matched) return matched;
  }
  const assetRef = stringFromWorkflowValue(shot.assetRef);
  const refIndex = Number(assetRef.match(/Product_(\d+)/i)?.[1] || 0) - 1;
  if (refIndex >= 0 && products[refIndex]) return products[refIndex];
  const titleKey = normalizeWorkflowAssetMatchText(shot.title);
  return products.find((asset) => normalizeWorkflowAssetMatchText(asset.name || asset.title || asset.productProfile?.productName) === titleKey) || products[0] || null;
}

function workflowProductAssetsFromConfig(workflow = {}) {
  const assets = workflow.ecommerceAssets && typeof workflow.ecommerceAssets === "object" ? workflow.ecommerceAssets : {};
  const products = Array.isArray(assets.products) ? assets.products : assets.products ? [assets.products] : [];
  return products.map(normalizeWorkflowProductAsset).filter((asset) => asset.id || asset.name);
}

function normalizeWorkflowProductAsset(asset = {}) {
  const payload = asset?.payload && typeof asset.payload === "object" ? asset.payload : {};
  const productProfile = payload.productProfile || asset.productProfile || {};
  return {
    ...payload,
    ...asset,
    id: asset.id || payload.id || asset.assetId || "",
    type: asset.type || payload.type || "product",
    name: asset.name || payload.name || productProfile.productName || "未命名商品",
    groupId: asset.groupId || payload.groupId || "",
    prompt: payload.prompt || asset.prompt || "",
    fileUrl: asset.fileUrl || payload.fileUrl || "",
    fileKey: asset.fileKey || payload.fileKey || "",
    mimeType: asset.mimeType || payload.mimeType || "",
    sizeBytes: Number(asset.sizeBytes || payload.sizeBytes || 0),
    productProfile,
    productImageUrl: payload.productImageUrl || asset.productImageUrl || productProfile.productImageUrl || "",
    productImageThumbnailUrl: payload.productImageThumbnailUrl || asset.productImageThumbnailUrl || productProfile.productImageThumbnailUrl || "",
    createdAt: asset.createdAt || payload.createdAt || "",
    updatedAt: asset.updatedAt || payload.updatedAt || "",
  };
}

function workflowProductAssetId(shot = {}, asset = null) {
  return stringFromWorkflowValue(shot.productAssetId || shot.assetId || asset?.id || asset?.assetId);
}

function uploadedProductImageUrl(uploaded = {}) {
  return resolveFlowStudioFileUrl(uploaded?.url || uploaded?.fileUrl || uploaded?.imageUrl || "");
}

function workflowProductAssetWithImage(asset = {}, shot = {}, assetId = "", imagePatch = {}) {
  const normalized = normalizeWorkflowProductAsset(asset || {});
  const productProfile = normalized.productProfile && typeof normalized.productProfile === "object" ? normalized.productProfile : {};
  const productName = stringFromWorkflowValue(productProfile.productName || normalized.name || shot.title || "未命名商品");
  const now = new Date().toISOString();
  return {
    ...normalized,
    id: assetId || normalized.id,
    type: "product",
    name: productName,
    productImageUrl: imagePatch.productImageUrl || normalized.productImageUrl || "",
    productImageThumbnailUrl: imagePatch.productImageThumbnailUrl || normalized.productImageThumbnailUrl || "",
    productProfile: {
      ...productProfile,
      productName,
      ...imagePatch,
    },
    updatedAt: now,
  };
}

function workflowProductAssetSavePayload(asset = {}) {
  const productProfile = asset.productProfile && typeof asset.productProfile === "object" ? asset.productProfile : {};
  return {
    id: asset.id,
    name: asset.name || productProfile.productName || "未命名商品",
    groupId: asset.groupId || "",
    fileUrl: asset.fileUrl || asset.sourceFile?.fileUrl || "",
    fileKey: asset.fileKey || asset.sourceFile?.fileKey || "",
    mimeType: asset.mimeType || asset.sourceFile?.mimeType || "",
    sizeBytes: Number(asset.sizeBytes || asset.sourceFile?.sizeBytes || 0),
    createdAt: asset.createdAt || "",
    shared: Boolean(asset.shared || asset.scope === "team"),
    payload: {
      ...asset,
      name: asset.name || productProfile.productName || "未命名商品",
      productProfile,
      productImageUrl: asset.productImageUrl || productProfile.productImageUrl || "",
      productImageThumbnailUrl: asset.productImageThumbnailUrl || productProfile.productImageThumbnailUrl || "",
    },
  };
}

function workflowShotsWithProductImage(shots = [], targetShot = {}, productAsset = {}) {
  const imageUrl = productAsset.productImageUrl || productAsset.productProfile?.productImageUrl || "";
  const imageThumbnailUrl = productAsset.productImageThumbnailUrl || productAsset.productProfile?.productImageThumbnailUrl || imageUrl;
  return (Array.isArray(shots) ? shots : []).map((shot) => {
    if (!workflowProductShotMatchesAsset(shot, targetShot, productAsset)) return shot;
    return {
      ...shot,
      assetId: productAsset.id || shot.assetId || "",
      productAssetId: productAsset.id || shot.productAssetId || "",
      imageUrl,
      imageThumbnailUrl,
      imageStatus: "done",
      imageSource: "product-library",
      imageError: "",
      imagePauseReason: "",
    };
  });
}

function workflowProductShotMatchesAsset(shot = {}, targetShot = {}, productAsset = {}) {
  if (shot.assetType !== "product") return false;
  const shotId = workflowShotId(shot);
  if (shotId && shotId === workflowShotId(targetShot)) return true;
  const assetId = workflowProductAssetId(shot, null);
  if (assetId && productAsset.id && assetId === productAsset.id) return true;
  const targetRef = stringFromWorkflowValue(targetShot.assetRef);
  if (targetRef && stringFromWorkflowValue(shot.assetRef) === targetRef) return true;
  const title = normalizeWorkflowAssetMatchText(shot.title);
  const productTitle = normalizeWorkflowAssetMatchText(productAsset.name || productAsset.productProfile?.productName);
  return Boolean(title && productTitle && title === productTitle);
}

function workflowSnapshotWithProductImage(snapshot = {}, productAsset = {}) {
  const base = snapshot && typeof snapshot === "object" ? snapshot : {};
  const ecommerceAssets = base.ecommerceAssets && typeof base.ecommerceAssets === "object" ? base.ecommerceAssets : {};
  const originalProducts = ecommerceAssets.products;
  const products = Array.isArray(originalProducts) ? originalProducts : originalProducts ? [originalProducts] : [];
  const nextProducts = products.map((asset) => (
    workflowProductAssetId({}, asset) === productAsset.id
      ? {
          ...asset,
          ...productAsset,
          productProfile: {
            ...(asset.productProfile && typeof asset.productProfile === "object" ? asset.productProfile : {}),
            ...(productAsset.productProfile && typeof productAsset.productProfile === "object" ? productAsset.productProfile : {}),
          },
        }
      : asset
  ));
  const hasProduct = nextProducts.some((asset) => workflowProductAssetId({}, asset) === productAsset.id);
  if (!hasProduct && productAsset.id) nextProducts.push(productAsset);
  return {
    ...base,
    ecommerceAssets: {
      ...ecommerceAssets,
      products: Array.isArray(originalProducts) ? nextProducts : nextProducts[0] || null,
    },
    productAssetId: productAsset.id || base.productAssetId || "",
  };
}

async function syncWorkflowProductSnapshot(workflow = {}, nextSnapshot = {}) {
  const workflowId = workflow?.id || nextSnapshot?.id || "";
  if (!workflowId) return;
  try {
    await updateWorkflow(workflowId, {
      name: nextSnapshot.name || workflow.name || "未命名工作流",
      type: nextSnapshot.type || workflow.type || "ecommerce",
      config: nextSnapshot,
    });
  } catch (error) {
    console.warn("[workflow-run] product image workflow snapshot sync failed", error?.message || error);
  }
}

function workflowShotPromptText(shot) {
  return stringFromWorkflowValue(shot?.imagePrompt || shot?.prompt || shot?.description || shot?.text).trim();
}

function buildWorkflowImagePromptLikeCreate(shot, visualStylePrompt = "") {
  const roleAsset = stringFromWorkflowValue(shot?.assetType).trim().toLowerCase() === "role";
  const shotPrompt = roleAsset
    ? stripWorkflowRoleImageStyle(workflowShotPromptText(shot))
    : workflowShotPromptText(shot);
  return [shotPrompt, !roleAsset && visualStylePrompt ? `风格参考：${visualStylePrompt}` : ""]
    .filter(Boolean)
    .join("\n\n");
}

function workflowImagePromptOverrides(run, shotIds = [], visualStylePrompt = "") {
  const requestedIds = new Set(shotIds.map(String).filter(Boolean));
  const shots = Array.isArray(run?.shots) ? run.shots : [];
  return Object.fromEntries(
    shots
      .filter((shot) => !requestedIds.size || requestedIds.has(workflowShotId(shot)))
      .map((shot) => [workflowShotId(shot), buildWorkflowImagePromptLikeCreate(shot, visualStylePrompt)])
      .filter(([shotId, prompt]) => shotId && prompt)
  );
}

function normalizeWorkflowRun(run) {
  const result = run?.result && typeof run.result === "object" ? run.result : {};
  const kind = run?.kind === "main" ? "topic-seed" : run?.kind === "child" ? "topic-child" : run?.kind;
  const shotOutput = stringFromWorkflowValue(result.shotOutput || run?.shotOutput);
  const storedShots = Array.isArray(result.shots) ? result.shots : Array.isArray(run?.shots) ? run.shots : [];
  const shots = repairEcommerceRoleImagePrompts(storedShots, shotOutput).map((shot) => {
    if (stringFromWorkflowValue(shot?.assetType).trim().toLowerCase() !== "role") return shot;
    const prompt = stripWorkflowRoleImageStyle(shot.imagePrompt || shot.prompt || "");
    return {
      ...shot,
      imagePrompt: prompt,
      prompt,
    };
  });
  const videoPackage = objectFromWorkflowValue(result.videoPackage || run?.videoPackage);
  const videoResultPackage = objectFromWorkflowValue(result.videoResultPackage || run?.videoResultPackage);
  const imagePackage = objectFromWorkflowValue(result.imagePackage || run?.imagePackage);
  const audio = objectFromWorkflowValue(result.audio || run?.audio);
  const timeline = objectFromWorkflowValue(result.timeline || run?.timeline);
  const draft = objectFromWorkflowValue(result.draft || run?.draft);
  const draftConfig = objectFromWorkflowValue(result.draftConfig || run?.draftConfig || draft.config);
  return {
    ...(run || {}),
    ...result,
    id: run?.id || result.id || "",
    workflowId: run?.workflowId || result.workflowId || "",
    parentRunId: run?.parentRunId || result.parentRunId || "",
    kind: kind || result.kind || "",
    status: run?.status || result.status || "waiting",
    stages: run?.stages || result.stages || {},
    shots,
    generatedTopics: Array.isArray(result.generatedTopics) ? result.generatedTopics : Array.isArray(run?.generatedTopics) ? run.generatedTopics : [],
    selectedTopics: Array.isArray(result.selectedTopics) ? result.selectedTopics : Array.isArray(run?.selectedTopics) ? run.selectedTopics : [],
    confirmedTopics: Array.isArray(result.confirmedTopics) ? result.confirmedTopics : Array.isArray(run?.confirmedTopics) ? run.confirmedTopics : [],
    confirmedTopicIndexes: Array.isArray(result.confirmedTopicIndexes) ? result.confirmedTopicIndexes : Array.isArray(run?.confirmedTopicIndexes) ? run.confirmedTopicIndexes : [],
    topicAdaptations: objectFromWorkflowValue(result.topicAdaptations || run?.topicAdaptations),
    topicAdaptation: stringFromWorkflowValue(result.topicAdaptation || run?.topicAdaptation),
    topicAdaptationBrief: stringFromWorkflowValue(result.topicAdaptationBrief || run?.topicAdaptationBrief),
    topicGenerationStatus: result.topicGenerationStatus || run?.topicGenerationStatus || "",
    topicGenerationError: result.topicGenerationError || run?.topicGenerationError || "",
    audio,
    audioUrl: result.audioUrl || run?.audioUrl || audio.audio_url || audio.audioUrl || audio.url || "",
    audioDuration: Number(result.audioDuration || run?.audioDuration || audio.duration || 0),
    audioRawSegments: firstWorkflowArray(result.audioRawSegments, run?.audioRawSegments, audio.raw_segments, audio.rawSegments),
    audioSegments: firstWorkflowArray(result.audioSegments, run?.audioSegments, audio.segments),
    subtitleSrt: result.subtitleSrt || run?.subtitleSrt || audio.subtitle_srt || audio.subtitleSrt || "",
    audioStatus: result.audioStatus || run?.audioStatus || audio.status || "",
    audioError: result.audioError || run?.audioError || audio.error || "",
    timeline,
    videoTimeline: Array.isArray(result.videoTimeline) ? result.videoTimeline : Array.isArray(run?.videoTimeline) ? run.videoTimeline : [],
    videoResults: firstWorkflowArray(result.videoResults, run?.videoResults, result.videos, run?.videos),
    shotAssetRefs: objectFromWorkflowValue(result.shotAssetRefs || run?.shotAssetRefs),
    roleOutfitVariantStatus: result.roleOutfitVariantStatus || run?.roleOutfitVariantStatus || result.roleOutfitVariantSummary?.status || "",
    roleOutfitVariantSummary: objectFromWorkflowValue(result.roleOutfitVariantSummary || run?.roleOutfitVariantSummary),
    videoPackage,
    videoPackageStatus: result.videoPackageStatus || run?.videoPackageStatus || videoPackage.status || "",
    videoPackageName: result.videoPackageName || run?.videoPackageName || videoPackage.name || videoPackage.fileName || "",
    videoPackageDetail: result.videoPackageDetail || run?.videoPackageDetail || videoPackage.detail || "",
    videoPackageError: result.videoPackageError || run?.videoPackageError || videoPackage.error || "",
    videoPackageProgress: result.videoPackageProgress || run?.videoPackageProgress || videoPackage.progress || 0,
    videoPackageDone: result.videoPackageDone || run?.videoPackageDone || videoPackage.done || 0,
    videoPackageTotal: result.videoPackageTotal || run?.videoPackageTotal || videoPackage.total || 0,
    videoResultPackage,
    videoResultPackageStatus: result.videoResultPackageStatus || run?.videoResultPackageStatus || videoResultPackage.status || "",
    videoResultPackageTaskId: result.videoResultPackageTaskId || run?.videoResultPackageTaskId || videoResultPackage.id || videoResultPackage.jobId || "",
    videoResultPackageName: result.videoResultPackageName || run?.videoResultPackageName || videoResultPackage.name || videoResultPackage.fileName || "",
    videoResultPackageDetail: result.videoResultPackageDetail || run?.videoResultPackageDetail || videoResultPackage.detail || "",
    videoResultPackageError: result.videoResultPackageError || run?.videoResultPackageError || videoResultPackage.error || "",
    videoResultPackageProgress: result.videoResultPackageProgress || run?.videoResultPackageProgress || videoResultPackage.progress || 0,
    videoResultPackageDone: result.videoResultPackageDone || run?.videoResultPackageDone || videoResultPackage.done || 0,
    videoResultPackageTotal: result.videoResultPackageTotal || run?.videoResultPackageTotal || videoResultPackage.total || 0,
    videoResultPackageDownloadPath: result.videoResultPackageDownloadPath || run?.videoResultPackageDownloadPath || videoResultPackage.downloadPath || "",
    videoResultPackageExpiresAt: result.videoResultPackageExpiresAt || run?.videoResultPackageExpiresAt || videoResultPackage.expiresAt || 0,
    imagePackage,
    imagePackageStatus: result.imagePackageStatus || run?.imagePackageStatus || imagePackage.status || "",
    imagePackageTaskId: result.imagePackageTaskId || run?.imagePackageTaskId || imagePackage.id || imagePackage.jobId || "",
    imagePackageName: result.imagePackageName || run?.imagePackageName || imagePackage.name || imagePackage.fileName || "",
    imagePackageDetail: result.imagePackageDetail || run?.imagePackageDetail || imagePackage.detail || "",
    imagePackageError: result.imagePackageError || run?.imagePackageError || imagePackage.error || "",
    imagePackageProgress: result.imagePackageProgress || run?.imagePackageProgress || imagePackage.progress || 0,
    imagePackageDone: result.imagePackageDone || run?.imagePackageDone || imagePackage.done || 0,
    imagePackageTotal: result.imagePackageTotal || run?.imagePackageTotal || imagePackage.total || 0,
    imagePackageDownloadPath: result.imagePackageDownloadPath || run?.imagePackageDownloadPath || imagePackage.downloadPath || "",
    imagePackageExpiresAt: result.imagePackageExpiresAt || run?.imagePackageExpiresAt || imagePackage.expiresAt || 0,
    draft,
    draftConfig,
    draftStatus: result.draftStatus || run?.draftStatus || draft.status || "",
    draftUrl: result.draftUrl || run?.draftUrl || draft.draft_url || draft.draftUrl || draft.url || "",
    draftId: result.draftId || run?.draftId || draft.draft_id || draft.draftId || draft.id || "",
    draftError: result.draftError || run?.draftError || draft.error || "",
    createdAt: run?.createdAt || result.createdAt || "",
    updatedAt: run?.updatedAt || result.updatedAt || "",
    completedAt: run?.completedAt || result.completedAt || "",
    storedOnServer: true,
  };
}

function workflowRunSummary(run) {
  const topics = uniqueWorkflowTextList([
    ...(Array.isArray(run.confirmedTopics) ? run.confirmedTopics : []),
    ...(Array.isArray(run.selectedTopics) ? run.selectedTopics : []),
    ...(Array.isArray(run.generatedTopics) ? run.generatedTopics : []),
  ]);
  const script = stringFromWorkflowValue(run.scriptOutput || run.script || run.content);
  const optimizedScript = stringFromWorkflowValue(run.scriptTranslation || run.optimizedScript || run.optimizedOutput || run.optimizationOutput);
  const translationLanguage = stringFromWorkflowValue(run.scriptTranslationLanguage).trim().toLowerCase();
  const shots = Array.isArray(run.shots) ? run.shots : [];
  const audio = objectFromWorkflowValue(run.audio);
  const audioTracks = workflowAudioTracksFromRun(run);
  const activeAudio = audioTracks.at(-1) || audio;
  const audioUrl = resolveFlowStudioFileUrl(run.audioUrl || activeAudio.audio_url || activeAudio.audioUrl || activeAudio.url || audio.audio_url || audio.audioUrl || audio.url || "");
  const audioDuration = Number(run.audioDuration || activeAudio.duration || audio.duration || 0);
  const audioRawSegments = firstWorkflowArray(run.audioRawSegments, activeAudio.rawSegments, audio.raw_segments, audio.rawSegments);
  const audioSegments = firstWorkflowArray(run.audioSegments, activeAudio.segments, audio.segments);
  const subtitleSrt = stringFromWorkflowValue(run.subtitleSrt || activeAudio.subtitle_srt || activeAudio.subtitleSrt || audio.subtitle_srt || audio.subtitleSrt);
  const timeline = objectFromWorkflowValue(run.timeline);
  const timelineSegments = Array.isArray(timeline.segments) && timeline.segments.length
    ? timeline.segments
    : audioSegments.map((segment, index) => {
        const shot = shots[index] || {};
        return {
          ...segment,
          image_url: segment.image_url || segment.imageUrl || workflowShotImageUrl(shot),
          video_url: segment.video_url || segment.videoUrl || "",
        };
      });
  const shotOutput = stringFromWorkflowValue(run.shotOutput);
  const shotAssetRefs = objectFromWorkflowValue(run.shotAssetRefs);
  const storyboardMode = stringFromWorkflowValue(run.storyboardMode) || "traditional";
  const aiDirectorPlan = objectFromWorkflowValue(run.aiDirectorPlan);
  const aiDirectorMaxDurationSeconds = Number(run.aiDirectorMaxDurationSeconds || aiDirectorPlan.maxDurationSeconds) || 0;
  const roleOutfitVariantSummary = objectFromWorkflowValue(run.roleOutfitVariantSummary);
  const imageShots = shots.filter((shot) => workflowShotImageUrl(shot));
  const videoTimeline = Array.isArray(run.videoTimeline) ? run.videoTimeline : [];
  const videoResults = Array.isArray(run.videoResults) ? run.videoResults : [];
  const videoPackageUrl = workflowPackageUrl(run.videoPackage || run);
  const computedVideoStatus = workflowVideoStageFromResults(videoResults, videoTimeline);
  const videoStatus = computedVideoStatus !== "pending" ? computedVideoStatus : (videoTimeline.length ? "" : run.videoStatus || "");
  const draft = objectFromWorkflowValue(run.draft);
  const draftConfig = objectFromWorkflowValue(run.draftConfig || draft.config);
  const draftJob = objectFromWorkflowValue(run.backendJobs?.draft);
  const draftUrl = run.draftUrl || draft.draft_url || draft.draftUrl || draft.url || "";
  const draftId = run.draftId || draft.draft_id || draft.draftId || draft.id || "";
  const draftError = run.draftError || draft.error || "";
  const draftProgress = draftUrl ? 100 : Math.max(0, Math.min(100, Number(draftJob.progress || 0)));
  const draftProgressDetail = stringFromWorkflowValue(draftJob.result?.detail || draftJob.result?.stageLabel);

  return {
    topics,
    script,
    optimizedScript,
    translationLanguage,
    audio,
    audioTracks,
    audioUrl,
    audioDuration,
    audioRawSegments,
    audioSegments,
    subtitleSrt,
    timeline,
    timelineSegments,
    shotOutput,
    shotAssetRefs,
    storyboardMode,
    aiDirectorPlan,
    aiDirectorMaxDurationSeconds,
    roleOutfitVariantStatus: run.roleOutfitVariantStatus || roleOutfitVariantSummary.status || "",
    roleOutfitVariantSummary,
    shots,
    imageShots,
    videoTimeline,
    videoResults,
    videoStatus,
    videoPackageStatus: run.videoPackageStatus || run.videoPackage?.status || "",
    videoPackageDetail: run.videoPackageDetail || run.videoPackage?.detail || "",
    videoPackageError: run.videoPackageError || run.videoPackage?.error || "",
    videoPackageName: run.videoPackageName || run.videoPackage?.fileName || run.videoPackage?.name || "",
    videoPackageProgress: run.videoPackageProgress || run.videoPackage?.progress || 0,
    videoPackageDone: run.videoPackageDone || run.videoPackage?.done || 0,
    videoPackageTotal: run.videoPackageTotal || run.videoPackage?.total || 0,
    videoPackage: run.videoPackage || {},
    videoResultPackageStatus: run.videoResultPackageStatus || run.videoResultPackage?.status || "",
    videoResultPackageDetail: run.videoResultPackageDetail || run.videoResultPackage?.detail || "",
    videoResultPackageError: run.videoResultPackageError || run.videoResultPackage?.error || "",
    videoResultPackageName: run.videoResultPackageName || run.videoResultPackage?.fileName || run.videoResultPackage?.name || "",
    videoResultPackageProgress: run.videoResultPackageProgress || run.videoResultPackage?.progress || 0,
    videoResultPackageDone: run.videoResultPackageDone || run.videoResultPackage?.done || 0,
    videoResultPackageTotal: run.videoResultPackageTotal || run.videoResultPackage?.total || 0,
    videoResultPackageDownloadPath: run.videoResultPackageDownloadPath || run.videoResultPackage?.downloadPath || "",
    videoResultPackageExpiresAt: run.videoResultPackageExpiresAt || run.videoResultPackage?.expiresAt || 0,
    videoResultPackage: run.videoResultPackage || {},
    videoPackageUrl,
    draft,
    draftConfig,
    draftUrl,
    draftId,
    draftError,
    draftProgress,
    draftProgressDetail,
    hasResult: Boolean(topics.length || script || optimizedScript || audioUrl || audioSegments.length || shotOutput || shots.length || imageShots.length || videoTimeline.length || videoResults.length || draftUrl || videoStatus || videoPackageUrl),
  };
}

function uniqueWorkflowTextList(values) {
  const seen = new Set();
  return values.reduce((items, value) => {
    const text = stringFromWorkflowValue(value).trim();
    if (!text || seen.has(text)) return items;
    seen.add(text);
    return [...items, text];
  }, []);
}

function stringFromWorkflowValue(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(stringFromWorkflowValue).filter(Boolean).join("\n");
  if (typeof value === "object") {
    return value.title || value.topic || value.name || value.text || value.content || value.summary || value.description || value.prompt || value.url || value.videoUrl || "";
  }
  return "";
}

function objectFromWorkflowValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function workflowRunResultSnapshot(run, patch = {}) {
  return {
    workflowSnapshot: workflowSnapshotFromRun(run),
    generatedTopics: Array.isArray(run?.generatedTopics) ? run.generatedTopics : [],
    selectedTopics: Array.isArray(run?.selectedTopics) ? run.selectedTopics : [],
    confirmedTopics: Array.isArray(run?.confirmedTopics) ? run.confirmedTopics : [],
    confirmedTopicIndexes: Array.isArray(run?.confirmedTopicIndexes) ? run.confirmedTopicIndexes : [],
    topicAdaptations: objectFromWorkflowValue(run?.topicAdaptations),
    topicAdaptation: stringFromWorkflowValue(run?.topicAdaptation),
    topicAdaptationBrief: stringFromWorkflowValue(run?.topicAdaptationBrief),
    topicGenerationStatus: stringFromWorkflowValue(run?.topicGenerationStatus),
    topicGenerationError: stringFromWorkflowValue(run?.topicGenerationError),
    scriptOutput: stringFromWorkflowValue(run?.scriptOutput || run?.script || run?.content),
    scriptError: stringFromWorkflowValue(run?.scriptError),
    scriptTranslation: stringFromWorkflowValue(run?.scriptTranslation),
    scriptTranslationStatus: stringFromWorkflowValue(run?.scriptTranslationStatus),
    scriptTranslationError: stringFromWorkflowValue(run?.scriptTranslationError),
    scriptTranslationLanguage: stringFromWorkflowValue(run?.scriptTranslationLanguage),
    optimizationVersions: Array.isArray(run?.optimizationVersions) ? run.optimizationVersions : [],
    activeOptimizationVersionId: stringFromWorkflowValue(run?.activeOptimizationVersionId),
    complianceReport: objectFromWorkflowValue(run?.complianceReport),
    optimizationStatus: stringFromWorkflowValue(run?.optimizationStatus),
    optimizationError: stringFromWorkflowValue(run?.optimizationError),
    audio: objectFromWorkflowValue(run?.audio),
    audioTracks: firstWorkflowArray(run?.audioTracks),
    audioUrl: stringFromWorkflowValue(run?.audioUrl),
    audioDuration: Number(run?.audioDuration) || 0,
    ...(Array.isArray(run?.audioRawSegments) && run.audioRawSegments.length ? { audioRawSegments: run.audioRawSegments } : {}),
    audioSegments: Array.isArray(run?.audioSegments) ? run.audioSegments : [],
    subtitleSrt: stringFromWorkflowValue(run?.subtitleSrt),
    audioStatus: stringFromWorkflowValue(run?.audioStatus),
    audioError: stringFromWorkflowValue(run?.audioError),
    timeline: objectFromWorkflowValue(run?.timeline),
    ...(run?.talkingShotSegmentationMode || run?.talkingShotSegmentationPlan?.length || run?.talkingShotSourceAudioSegments?.length || run?.talkingShotSourceSubtitleSrt ? {
      talkingShotSegmentationMode: stringFromWorkflowValue(run?.talkingShotSegmentationMode),
      talkingShotSegmentationPlan: Array.isArray(run?.talkingShotSegmentationPlan) ? run.talkingShotSegmentationPlan : [],
      talkingShotSourceAudioSegments: Array.isArray(run?.talkingShotSourceAudioSegments) ? run.talkingShotSourceAudioSegments : [],
      talkingShotSourceSubtitleSrt: stringFromWorkflowValue(run?.talkingShotSourceSubtitleSrt),
    } : {}),
    shotOutput: stringFromWorkflowValue(run?.shotOutput),
    shotAssetRefs: objectFromWorkflowValue(run?.shotAssetRefs),
    shotError: stringFromWorkflowValue(run?.shotError),
    storyboardMode: stringFromWorkflowValue(run?.storyboardMode),
    aiDirectorPlan: objectFromWorkflowValue(run?.aiDirectorPlan),
    aiDirectorMaxDurationSeconds: Number(run?.aiDirectorMaxDurationSeconds) || 0,
    shots: Array.isArray(run?.shots) ? run.shots : [],
    roleOutfitVariantStatus: stringFromWorkflowValue(run?.roleOutfitVariantStatus || run?.roleOutfitVariantSummary?.status),
    roleOutfitVariantSummary: objectFromWorkflowValue(run?.roleOutfitVariantSummary),
    videoTimeline: Array.isArray(run?.videoTimeline) ? run.videoTimeline : [],
    videoResults: Array.isArray(run?.videoResults) ? run.videoResults : [],
    videoResultTombstones: objectFromWorkflowValue(run?.videoResultTombstones),
    videoPackage: objectFromWorkflowValue(run?.videoPackage),
    videoPackageStatus: stringFromWorkflowValue(run?.videoPackageStatus),
    videoPackageName: stringFromWorkflowValue(run?.videoPackageName),
    videoPackageDetail: stringFromWorkflowValue(run?.videoPackageDetail),
    videoPackageError: stringFromWorkflowValue(run?.videoPackageError),
    videoPackageProgress: Number(run?.videoPackageProgress) || 0,
    videoPackageDone: Number(run?.videoPackageDone) || 0,
    videoPackageTotal: Number(run?.videoPackageTotal) || 0,
    videoResultPackage: objectFromWorkflowValue(run?.videoResultPackage),
    videoResultPackageStatus: stringFromWorkflowValue(run?.videoResultPackageStatus),
    videoResultPackageTaskId: stringFromWorkflowValue(run?.videoResultPackageTaskId),
    videoResultPackageName: stringFromWorkflowValue(run?.videoResultPackageName),
    videoResultPackageDetail: stringFromWorkflowValue(run?.videoResultPackageDetail),
    videoResultPackageError: stringFromWorkflowValue(run?.videoResultPackageError),
    videoResultPackageProgress: Number(run?.videoResultPackageProgress) || 0,
    videoResultPackageDone: Number(run?.videoResultPackageDone) || 0,
    videoResultPackageTotal: Number(run?.videoResultPackageTotal) || 0,
    videoResultPackageDownloadPath: stringFromWorkflowValue(run?.videoResultPackageDownloadPath),
    videoResultPackageExpiresAt: run?.videoResultPackageExpiresAt || 0,
    imagePackage: objectFromWorkflowValue(run?.imagePackage),
    imagePackageStatus: stringFromWorkflowValue(run?.imagePackageStatus),
    imagePackageTaskId: stringFromWorkflowValue(run?.imagePackageTaskId),
    imagePackageName: stringFromWorkflowValue(run?.imagePackageName),
    imagePackageDetail: stringFromWorkflowValue(run?.imagePackageDetail),
    imagePackageError: stringFromWorkflowValue(run?.imagePackageError),
    imagePackageProgress: Number(run?.imagePackageProgress) || 0,
    imagePackageDone: Number(run?.imagePackageDone) || 0,
    imagePackageTotal: Number(run?.imagePackageTotal) || 0,
    imagePackageDownloadPath: stringFromWorkflowValue(run?.imagePackageDownloadPath),
    imagePackageExpiresAt: run?.imagePackageExpiresAt || 0,
    draft: objectFromWorkflowValue(run?.draft),
    draftStatus: stringFromWorkflowValue(run?.draftStatus),
    draftUrl: stringFromWorkflowValue(run?.draftUrl),
    draftId: stringFromWorkflowValue(run?.draftId),
    draftError: stringFromWorkflowValue(run?.draftError),
    backendJobs: objectFromWorkflowValue(run?.backendJobs),
    ...patch,
  };
}

function workflowResetAfterScriptResult(patch = {}) {
  return {
    scriptTranslation: "",
    scriptTranslationStatus: "",
    scriptTranslationError: "",
    scriptTranslationLanguage: "",
    optimizePreviousStatus: "",
    audio: {},
    audioTracks: [],
    audioUrl: "",
    audioDuration: 0,
    audioSegments: [],
    subtitleSrt: "",
    audioStatus: "",
    audioError: "",
    timeline: {},
    draft: {},
    draftStatus: "",
    draftUrl: "",
    draftId: "",
    draftError: "",
    shotOutput: "",
    shotError: "",
    shots: [],
    storyboardMode: "",
    aiDirectorPlan: {},
    aiDirectorMaxDurationSeconds: 0,
    roleOutfitVariantStatus: "",
    roleOutfitVariantSummary: {},
    videoTimeline: [],
    videoResults: [],
    videoStatus: "",
    videoPackage: {},
    videoPackageStatus: "",
    videoPackageName: "",
    videoPackageDetail: "",
    videoPackageError: "",
    ...workflowResetVideoResultPackageResult(),
    timeline: {},
    draft: {},
    draftStatus: "",
    draftUrl: "",
    draftId: "",
    draftError: "",
    ...workflowResetImagePackageResult(),
    ...patch,
  };
}

function workflowStagesAfterOptimization(run = {}, talkingVideo = false) {
  return {
    ...(run.stages || {}),
    topic: run.kind === "topic-child" ? "skipped" : run.stages?.topic || "done",
    outline: "skipped",
    script: "done",
    optimize: talkingVideo ? "skipped" : "done",
    audio: "pending",
    shot: "pending",
    image: "pending",
    videoPrompt: "pending",
    video: "pending",
    draft: "pending",
  };
}

function workflowOptimizationVersions(run = {}, currentScript = "") {
  const stored = (Array.isArray(run?.optimizationVersions) ? run.optimizationVersions : [])
    .map((version, index) => ({
      ...version,
      id: stringFromWorkflowValue(version?.id) || `script-version-${index + 1}`,
      number: Number(version?.number) || index + 1,
      content: stringFromWorkflowValue(version?.content),
      prompt: stringFromWorkflowValue(version?.prompt),
      sourceVersionId: stringFromWorkflowValue(version?.sourceVersionId),
      createdAt: stringFromWorkflowValue(version?.createdAt),
      complianceReport: version?.complianceReport && typeof version.complianceReport === "object" ? version.complianceReport : null,
    }))
    .filter((version) => version.content);
  const script = String(currentScript || "").trim();
  if (!stored.length) {
    return script ? [{
      id: "script-version-1",
      number: 1,
      content: script,
      prompt: "",
      sourceVersionId: "",
      source: "initial",
      createdAt: run?.createdAt || run?.updatedAt || "",
      complianceReport: workflowReportMatchesScript(run?.complianceReport, script) ? run.complianceReport : null,
    }] : [];
  }
  if (!script || stored.some((version) => version.content === script)) return stored;
  const number = Math.max(0, ...stored.map((version) => version.number)) + 1;
  return [...stored, {
    id: `script-version-${number}`,
    number,
    content: script,
    prompt: "手动修改或重新生成文案",
    sourceVersionId: "",
    source: "external-edit",
    createdAt: run?.updatedAt || "",
    complianceReport: workflowReportMatchesScript(run?.complianceReport, script) ? run.complianceReport : null,
  }];
}

function workflowActiveOptimizationVersion(run = {}, versions = [], currentScript = "") {
  const activeId = stringFromWorkflowValue(run?.activeOptimizationVersionId);
  return versions.find((version) => version.id === activeId && version.content === currentScript)
    || [...versions].reverse().find((version) => version.content === currentScript)
    || versions.at(-1)
    || { id: "", number: 1, content: currentScript };
}

function workflowCurrentComplianceReport(run = {}, activeVersion = {}, currentScript = "") {
  const versionReport = activeVersion?.complianceReport;
  if (workflowReportMatchesScript(versionReport, currentScript)) return versionReport;
  return workflowReportMatchesScript(run?.complianceReport, currentScript) ? run.complianceReport : null;
}

function workflowReportMatchesScript(report, script = "") {
  return Boolean(report && typeof report === "object" && report.checkedText === script && Array.isArray(report.issues));
}

function workflowResetAfterShotResult(patch = {}, options = {}) {
  return {
    shotError: "",
    shotAssetRefs: {},
    storyboardMode: "",
    aiDirectorPlan: {},
    aiDirectorMaxDurationSeconds: 0,
    roleOutfitVariantStatus: "",
    roleOutfitVariantSummary: {},
    ...(options.preserveAudio ? {} : workflowResetAudioResult()),
    draft: {},
    draftStatus: "",
    draftUrl: "",
    draftId: "",
    draftError: "",
    videoTimeline: [],
    videoResults: [],
    videoStatus: "",
    videoPackage: {},
    videoPackageStatus: "",
    videoPackageName: "",
    videoPackageDetail: "",
    videoPackageError: "",
    ...workflowResetVideoResultPackageResult(),
    ...workflowResetImagePackageResult(),
    ...patch,
  };
}

function workflowResetAudioResult() {
  return {
    audio: {},
    audioTracks: [],
    audioUrl: "",
    audioDuration: 0,
    audioSegments: [],
    subtitleSrt: "",
    audioStatus: "",
    audioError: "",
    timeline: {},
  };
}

function workflowResetImagePackageResult() {
  return {
    imagePackage: {},
    imagePackageStatus: "",
    imagePackageTaskId: "",
    imagePackageName: "",
    imagePackageDetail: "",
    imagePackageError: "",
    imagePackageProgress: 0,
    imagePackageDone: 0,
    imagePackageTotal: 0,
    imagePackageDownloadPath: "",
    imagePackageExpiresAt: 0,
  };
}

function workflowImagePackageResult(job = {}) {
  return {
    imagePackage: {
      id: job.id || job.jobId || "",
      status: job.status || "",
      fileName: job.fileName || "",
      name: job.fileName || "",
      detail: job.detail || "",
      error: job.error || "",
      progress: Number(job.progress) || 0,
      done: Number(job.done) || 0,
      total: Number(job.total) || 0,
      downloadPath: job.downloadPath || "",
      expiresAt: job.expiresAt || 0,
    },
    imagePackageStatus: job.status || "",
    imagePackageTaskId: job.id || job.jobId || "",
    imagePackageName: job.fileName || "",
    imagePackageDetail: job.detail || "",
    imagePackageError: job.error || "",
    imagePackageProgress: Number(job.progress) || 0,
    imagePackageDone: Number(job.done) || 0,
    imagePackageTotal: Number(job.total) || 0,
    imagePackageDownloadPath: job.downloadPath || "",
    imagePackageExpiresAt: job.expiresAt || 0,
  };
}

function workflowImagePackageFromRun(run) {
  if (!run?.imagePackageStatus) return null;
  if (workflowPackageIsExpired(run.imagePackageExpiresAt)) {
    return {
      ...workflowImagePackageResult({
        status: "expired",
        detail: "下载链接已过期，请重新打包。",
        error: "下载链接已过期，请重新打包。",
      }).imagePackage,
      id: run.imagePackageTaskId || "",
      fileName: run.imagePackageName || "分镜图片.zip",
      downloadPath: run.imagePackageDownloadPath || "",
      expiresAt: run.imagePackageExpiresAt,
    };
  }
  return {
    id: run.imagePackageTaskId || run.imagePackage?.id || "",
    status: run.imagePackageStatus,
    done: run.imagePackageDone || 0,
    total: run.imagePackageTotal || 0,
    progress: run.imagePackageProgress || (run.imagePackageStatus === "done" || run.imagePackageStatus === "error" ? 100 : 0),
    detail: run.imagePackageDetail || "",
    fileName: run.imagePackageName || "分镜图片.zip",
    downloadPath: run.imagePackageDownloadPath || "",
    error: run.imagePackageError || "",
    expiresAt: run.imagePackageExpiresAt || 0,
  };
}

function workflowVideoResultPackageResult(job = {}) {
  return {
    videoResultPackage: {
      id: job.id || job.jobId || "",
      status: job.status || "",
      fileName: job.fileName || "",
      name: job.fileName || "",
      detail: job.detail || "",
      error: job.error || "",
      progress: Number(job.progress) || 0,
      done: Number(job.done) || 0,
      total: Number(job.total) || 0,
      downloadPath: job.downloadPath || "",
      expiresAt: job.expiresAt || 0,
    },
    videoResultPackageStatus: job.status || "",
    videoResultPackageTaskId: job.id || job.jobId || "",
    videoResultPackageName: job.fileName || "",
    videoResultPackageDetail: job.detail || "",
    videoResultPackageError: job.error || "",
    videoResultPackageProgress: Number(job.progress) || 0,
    videoResultPackageDone: Number(job.done) || 0,
    videoResultPackageTotal: Number(job.total) || 0,
    videoResultPackageDownloadPath: job.downloadPath || "",
    videoResultPackageExpiresAt: job.expiresAt || 0,
  };
}

function workflowVideoResultPackageFromRun(run) {
  if (!run?.videoResultPackageStatus) return null;
  if (workflowPackageIsExpired(run.videoResultPackageExpiresAt)) {
    return {
      ...workflowVideoResultPackageResult({
        status: "expired",
        progress: 100,
        detail: "下载链接已过期，请重新创建下载任务。",
        error: "下载链接已过期，请重新创建下载任务。",
      }).videoResultPackage,
      id: run.videoResultPackageTaskId || "",
      fileName: run.videoResultPackageName || "视频结果.zip",
      downloadPath: run.videoResultPackageDownloadPath || "",
      expiresAt: run.videoResultPackageExpiresAt,
    };
  }
  return {
    id: run.videoResultPackageTaskId || run.videoResultPackage?.id || "",
    status: run.videoResultPackageStatus,
    done: run.videoResultPackageDone || 0,
    total: run.videoResultPackageTotal || 0,
    progress: run.videoResultPackageProgress || (run.videoResultPackageStatus === "done" || run.videoResultPackageStatus === "error" ? 100 : 0),
    detail: run.videoResultPackageDetail || "",
    fileName: run.videoResultPackageName || "视频结果.zip",
    downloadPath: run.videoResultPackageDownloadPath || "",
    error: run.videoResultPackageError || "",
    expiresAt: run.videoResultPackageExpiresAt || 0,
  };
}

function workflowRoleNameWatermarkText(shot = {}) {
  const raw = cleanEcommerceAssetDisplayTitle(shot.title || shot.name || shot.roleName || shot.roleKey || "");
  const text = cleanEcommerceAssetDisplayTitle(stringFromWorkflowValue(raw)
    .replace(/^角色库\s*/, "")
    .replace(/^角色图\s*[·:：-]\s*/, "")
    .replace(/^角色\s*[·:：-]\s*/, ""))
    .replace(/[（(]\s*(?:主角|核心角色|重要配角|配角|边缘人物|人物|角色)\s*[）)]$/g, "")
    .trim();
  return (text.split(/[|｜/／]/)[0] || text || stringFromWorkflowValue(shot.roleKey)).trim();
}

function workflowSceneNameWatermarkText(shot = {}) {
  const raw = cleanEcommerceAssetDisplayTitle(shot.title || shot.name || shot.sceneName || shot.assetRef || "");
  return cleanEcommerceAssetDisplayTitle(stringFromWorkflowValue(raw)
    .replace(/^场景库\s*/, "")
    .replace(/^场景图\s*[·:：-]\s*/, "")
    .replace(/^场景\s*[·:：-]\s*/, ""))
    .split(/[|｜/／]/)[0]
    .trim();
}

function workflowWatermarkCustomText(value = "") {
  return stringFromWorkflowValue(value).replace(/\s+/g, " ").trim().slice(0, 32);
}

function workflowRoleNameWatermarkCurrent(shot = {}, text = "", imageUrl = "") {
  const watermark = objectFromWorkflowValue(shot.roleNameWatermark);
  if (!watermark.text || watermark.text !== text) return false;
  if (watermark.version !== workflowRoleNameWatermarkVersion) return false;
  return workflowComparableImageUrl(watermark.imageUrl || watermark.url) === workflowComparableImageUrl(imageUrl);
}

function workflowRoleNameWatermarkApplied(shot = {}, imageUrl = "") {
  const watermark = objectFromWorkflowValue(shot.roleNameWatermark);
  if (watermark.version !== workflowRoleNameWatermarkVersion) return false;
  return workflowComparableImageUrl(watermark.imageUrl || watermark.url) === workflowComparableImageUrl(imageUrl);
}

function workflowRoleNameWatermarkSourceUrl(shot = {}, fallbackUrl = "") {
  const watermark = objectFromWorkflowValue(shot.roleNameWatermark);
  return stringFromWorkflowValue(watermark.sourceImageUrl || watermark.originalImageUrl || fallbackUrl).trim();
}

function workflowRoleNameWatermarkSourceThumbnailUrl(shot = {}) {
  const watermark = objectFromWorkflowValue(shot.roleNameWatermark);
  return stringFromWorkflowValue(watermark.sourceThumbnailUrl || watermark.originalThumbnailUrl || "").trim();
}

function workflowRoleNameWatermarkRestorable(shot = {}) {
  return Boolean(workflowRoleNameWatermarkSourceUrl(shot, ""));
}

function workflowShotsWithRoleNameWatermarks(shots = [], updates = []) {
  const updateByShotId = new Map(updates.map((update) => [update.shotId, update]));
  return (Array.isArray(shots) ? shots : []).map((shot) => {
    const update = updateByShotId.get(workflowShotId(shot));
    if (!update) return shot;
    return {
      ...shot,
      imageUrl: update.nextImageUrl,
      imageThumbnailUrl: update.nextThumbnailUrl || "",
      fileUrl: "",
      url: "",
      imageStatus: "done",
      imageError: "",
      roleNameWatermark: {
        version: workflowRoleNameWatermarkVersion,
        mode: update.watermarkMode || "role",
        text: update.text,
        sourceImageUrl: update.imageUrl,
        sourceThumbnailUrl: update.thumbnailUrl || "",
        imageUrl: update.nextImageUrl,
        thumbnailUrl: update.nextThumbnailUrl || "",
        appliedAt: update.appliedAt,
      },
    };
  });
}

function workflowShotsWithoutRoleNameWatermarks(shots = [], updates = []) {
  const updateByShotId = new Map(updates.map((update) => [update.shotId, update]));
  return (Array.isArray(shots) ? shots : []).map((shot) => {
    const update = updateByShotId.get(workflowShotId(shot));
    if (!update) return shot;
    const { roleNameWatermark, ...rest } = shot;
    return {
      ...rest,
      imageUrl: update.sourceImageUrl,
      imageThumbnailUrl: update.sourceThumbnailUrl || "",
      fileUrl: "",
      url: "",
      imageStatus: "done",
      imageError: "",
    };
  });
}

function workflowVideoTimelineWithRoleNameWatermarks(timeline = [], updates = []) {
  if (!Array.isArray(timeline) || !timeline.length || !updates.length) return timeline;
  const updateByShotId = new Map(updates.map((update) => [update.shotId, update]));
  const updateByUrl = new Map();
  updates.forEach((update) => {
    [update.imageUrl, update.currentImageUrl].filter(Boolean).forEach((url) => {
      updateByUrl.set(workflowComparableImageUrl(url), update);
    });
  });
  const updateForItem = (item = {}) => {
    const shotId = stringFromWorkflowValue(item.shotId || item.id);
    return updateByShotId.get(shotId)
      || updateByUrl.get(workflowComparableImageUrl(item.imageUrl || item.fileUrl || item.url));
  };
  const applyMediaUpdate = (item = {}, update) => {
    if (!update) return item;
    return {
      ...item,
      imageUrl: update.nextImageUrl,
      imageThumbnailUrl: update.nextThumbnailUrl || "",
      thumbnailUrl: update.nextThumbnailUrl || "",
      fileUrl: "",
      url: item.url && [update.imageUrl, update.currentImageUrl].some((url) => workflowComparableImageUrl(item.url) === workflowComparableImageUrl(url)) ? update.nextImageUrl : item.url,
      roleNameWatermark: {
        version: workflowRoleNameWatermarkVersion,
        mode: update.watermarkMode || "role",
        text: update.text,
        sourceImageUrl: update.imageUrl,
        sourceThumbnailUrl: update.thumbnailUrl || "",
        imageUrl: update.nextImageUrl,
        thumbnailUrl: update.nextThumbnailUrl || "",
        appliedAt: update.appliedAt,
      },
    };
  };

  return timeline.map((item) => {
    const itemUpdate = updateForItem(item);
    const assets = Array.isArray(item.assets)
      ? item.assets.map((asset) => applyMediaUpdate(asset, updateForItem(asset)))
      : item.assets;
    return {
      ...applyMediaUpdate(item, itemUpdate),
      ...(Array.isArray(item.assets) ? { assets } : {}),
    };
  });
}

function workflowVideoTimelineWithoutRoleNameWatermarks(timeline = [], updates = []) {
  if (!Array.isArray(timeline) || !timeline.length || !updates.length) return timeline;
  const updateByShotId = new Map(updates.map((update) => [update.shotId, update]));
  const updateByUrl = new Map();
  updates.forEach((update) => {
    [update.currentImageUrl, update.sourceImageUrl].filter(Boolean).forEach((url) => {
      updateByUrl.set(workflowComparableImageUrl(url), update);
    });
  });
  const updateForItem = (item = {}) => {
    const shotId = stringFromWorkflowValue(item.shotId || item.id);
    return updateByShotId.get(shotId)
      || updateByUrl.get(workflowComparableImageUrl(item.imageUrl || item.fileUrl || item.url));
  };
  const applyMediaUpdate = (item = {}, update) => {
    if (!update) return item;
    const { roleNameWatermark, ...rest } = item;
    const matchesUrl = (value) => [update.currentImageUrl, update.sourceImageUrl].some((url) => workflowComparableImageUrl(value) === workflowComparableImageUrl(url));
    return {
      ...rest,
      imageUrl: update.sourceImageUrl,
      imageThumbnailUrl: update.sourceThumbnailUrl || "",
      thumbnailUrl: update.sourceThumbnailUrl || "",
      fileUrl: "",
      url: item.url && matchesUrl(item.url) ? update.sourceImageUrl : item.url,
    };
  };

  return timeline.map((item) => {
    const itemUpdate = updateForItem(item);
    const assets = Array.isArray(item.assets)
      ? item.assets.map((asset) => applyMediaUpdate(asset, updateForItem(asset)))
      : item.assets;
    return {
      ...applyMediaUpdate(item, itemUpdate),
      ...(Array.isArray(item.assets) ? { assets } : {}),
    };
  });
}

function workflowComparableImageUrl(value = "") {
  return resolveFlowStudioFileUrl(value).split("#")[0];
}

function workflowShotsWithPendingImages(shots = [], shotIds = [], options = {}) {
  const requestedIds = new Set(shotIds);
  return (Array.isArray(shots) ? shots : []).map((shot) => {
    const shotId = workflowShotId(shot);
    if (requestedIds.size && !requestedIds.has(shotId)) return shot;
    if (workflowShotImageUrl(shot) && !options.forceRegenerate) return shot;
    return {
      ...shot,
      imageUrl: "",
      imageThumbnailUrl: "",
      fileUrl: "",
      url: "",
      imageStatus: "pending",
      imageSource: "",
      imageError: "",
      imagePauseReason: "",
      imageProviderTaskId: options.forceRegenerate ? "" : shot.imageProviderTaskId,
      imageProviderChannel: options.forceRegenerate ? "" : shot.imageProviderChannel,
      imageProviderStatus: options.forceRegenerate ? "" : shot.imageProviderStatus,
      imageProviderLastSyncedAt: options.forceRegenerate ? "" : shot.imageProviderLastSyncedAt,
      imageRegenerateNonce: options.forceRegenerate ? createWorkflowLocalId("image") : shot.imageRegenerateNonce,
    };
  });
}

function workflowMissingImageShots(run) {
  return (Array.isArray(run?.shots) ? run.shots : []).filter((shot) => workflowShotRequiresGeneratedImage(shot) && !workflowShotImageUrl(shot));
}

function workflowImageNodeComplete(run, summary = null) {
  const shots = Array.isArray(summary?.shots) ? summary.shots : Array.isArray(run?.shots) ? run.shots : [];
  const generatedImageShots = shots.filter(workflowShotRequiresGeneratedImage);
  if (!generatedImageShots.length) return false;
  if (!generatedImageShots.every((shot) => workflowShotImageUrl(shot))) return false;
  if (workflowNodeIsRunning(run, "image")) return false;
  const imageShots = Array.isArray(summary?.imageShots)
    ? summary.imageShots.filter(workflowShotRequiresGeneratedImage)
    : generatedImageShots.filter((shot) => workflowShotImageUrl(shot));
  return run?.stages?.image === "done" || imageShots.length === generatedImageShots.length;
}

function workflowHasScriptDownstream(run) {
  const talkingVideo = isTalkingVideoWorkflow(run?.workflowSnapshot || run?.workflowConfig || run?.result?.workflowSnapshot || run?.result?.workflowConfig || run);
  if ((!talkingVideo && (run?.scriptTranslation || run?.scriptTranslationError)) || run?.shotOutput || run?.shotError) return true;
  if (run?.audioUrl || run?.audioError || run?.audioSegments?.length || run?.draftUrl || run?.draftError) return true;
  if (Array.isArray(run?.shots) && run.shots.length) return true;
  if (Array.isArray(run?.videoTimeline) && run.videoTimeline.length) return true;
  if (Array.isArray(run?.videoResults) && run.videoResults.length) return true;
  if (run?.videoPackageStatus || run?.videoPackageName || run?.videoPackageDetail || run?.videoPackageError) return true;
  const downstreamStages = talkingVideo
    ? ["audio", "shot", "image", "videoPrompt", "video", "draft"]
    : ["optimize", "audio", "shot", "image", "videoPrompt", "video", "draft"];
  return downstreamStages.some((stage) => {
    const status = run?.stages?.[stage];
    return status && status !== "pending";
  });
}

function workflowHasOptimizationDownstream(run) {
  if (run?.shotOutput || run?.shotError || run?.audioUrl || run?.audioError || run?.audioSegments?.length || run?.audioTracks?.length) return true;
  if (run?.draftUrl || run?.draftError || (Array.isArray(run?.shots) && run.shots.length)) return true;
  if (Array.isArray(run?.videoTimeline) && run.videoTimeline.length) return true;
  if (Array.isArray(run?.videoResults) && run.videoResults.length) return true;
  if (run?.videoPackageStatus || run?.videoPackageName || run?.videoPackageDetail || run?.videoPackageError) return true;
  return ["audio", "shot", "image", "videoPrompt", "video", "draft"].some((stage) => {
    const status = run?.stages?.[stage];
    return status && status !== "pending";
  });
}

function workflowHasShotDownstream(run) {
  if (Array.isArray(run?.shots) && run.shots.some((shot) => workflowShotImageUrl(shot) || shot.imageError || shot.imageStatus === "error")) return true;
  if (run?.audioUrl || run?.audioError || run?.audioSegments?.length || run?.audioTracks?.length) return true;
  if (Array.isArray(run?.videoTimeline) && run.videoTimeline.length) return true;
  if (Array.isArray(run?.videoResults) && run.videoResults.length) return true;
  if (run?.videoPackageStatus || run?.videoPackageName || run?.videoPackageDetail || run?.videoPackageError || run?.draftUrl || run?.draftError) return true;
  return ["image", "audio", "videoPrompt", "video", "draft"].some((stage) => {
    const status = run?.stages?.[stage];
    return status && status !== "pending";
  });
}

function workflowHasImageDownstream(run, workflow = null) {
  if (!isTalkingVideoWorkflow(workflow) && (run?.audioUrl || run?.audioError || run?.audioSegments?.length || run?.audioTracks?.length)) return true;
  if (Array.isArray(run?.videoTimeline) && run.videoTimeline.length) return true;
  if (Array.isArray(run?.videoResults) && run.videoResults.length) return true;
  if (run?.videoPackageStatus || run?.videoPackageName || run?.videoPackageDetail || run?.videoPackageError || run?.draftUrl || run?.draftError) return true;
  const downstreamStages = isTalkingVideoWorkflow(workflow) ? ["videoPrompt", "video", "draft"] : ["audio", "videoPrompt", "video", "draft"];
  return downstreamStages.some((stage) => {
    const status = run?.stages?.[stage];
    return status && status !== "pending";
  });
}

function parseWorkflowShots(content) {
  const text = String(content || "");
  const body = text.match(/\[START_OUTPUT\]([\s\S]*?)\[END_OUTPUT\]/)?.[1] || text;
  const shots = [];
  const pattern = /(?:^|\n)\s*(?:【镜头\s*(\d+)】|\[\s*Shot\s*(\d+)\s*\]|Shot\s*(\d+)\s*[:：-]?)([\s\S]*?)(?=\n\s*(?:【镜头\s*\d+】|\[\s*Shot\s*\d+\s*\]|Shot\s*\d+\s*[:：-]?)|$)/gi;
  let match;
  while ((match = pattern.exec(body))) {
    const index = Number(match[1] || match[2] || match[3]) || shots.length + 1;
    const block = String(match[4] || "").trim();
    const script = extractWorkflowShotField(block, workflowShotScriptLabels(), workflowShotImagePromptLabels());
    const prompt = extractWorkflowShotField(block, workflowShotImagePromptLabels(), workflowShotScriptLabels());
    if (script || prompt) {
      shots.push({
        id: createWorkflowLocalId(),
        index,
        script: cleanupWorkflowShotText(script),
        prompt: cleanupWorkflowShotText(prompt),
        imageUrl: "",
        imageThumbnailUrl: "",
        imageStatus: "pending",
        imageError: "",
      });
    }
  }
  return shots;
}

function workflowShotScriptLabels() {
  return ["对应文案", "Corresponding script", "Corresponding copy", "Script", "Voiceover", "Narration"];
}

function workflowShotImagePromptLabels() {
  return ["画面提示词", "图片提示词", "Image prompt", "Visual prompt", "Picture prompt", "Prompt"];
}

function extractWorkflowShotField(block = "", labels = [], stopLabels = []) {
  const labelPattern = labels.map(escapeWorkflowRegExp).join("|");
  const stopPattern = [...labels, ...stopLabels].map(escapeWorkflowRegExp).join("|");
  if (!labelPattern) return "";
  const pattern = new RegExp(`(?:^|\\n)\\s*(?:${labelPattern})\\s*[：:]\\s*([\\s\\S]*?)(?=\\n\\s*(?:${stopPattern})\\s*[：:]|$)`, "i");
  return block.match(pattern)?.[1]?.trim() || "";
}

function escapeWorkflowRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ecommerceShotResultTextOnly(content = "", script = "") {
  const text = stringFromWorkflowValue(content).trim();
  const scriptDetail = ecommerceScriptShotDetailText(text) || ecommerceScriptShotDetailText(script);
  const roleSection = text.match(/\[START_ROLE_MAPPING\][\s\S]*?\[END_ROLE_MAPPING\]/)?.[0] || "";
  const sceneSection = text.match(/\[START_SCENE_MAPPING\][\s\S]*?\[END_SCENE_MAPPING\]/)?.[0] || "";
  const productSection = text.match(/\[START_PRODUCT_MAPPING\][\s\S]*?\[END_PRODUCT_MAPPING\]/)?.[0] || "";
  const shotAssetSection = text.match(/\[START_SHOT_ASSET_MAPPING\][\s\S]*?\[END_SHOT_ASSET_MAPPING\]/)?.[0] || "";
  if (roleSection || sceneSection || productSection || shotAssetSection || scriptDetail) {
    return [
      "[START_OUTPUT]",
      roleSection,
      sceneSection,
      productSection,
      scriptDetail,
      "[END_OUTPUT]",
    ].filter(Boolean).join("\n\n").trim();
  }
  if (!text) return "";
  const cleaned = text
    .replace(/\n\s*(?:\[START_OUTPUT\]|第\s*1\s*镜|【镜头\s*1】)[\s\S]*$/g, "")
    .trim();
  return cleaned ? ["[START_OUTPUT]", cleaned, "[END_OUTPUT]"].join("\n\n") : "";
}

function aiDirectorStoryboardTextOnly(content = "") {
  const text = stringFromWorkflowValue(content).trim();
  const roleSection = text.match(/\[START_ROLE_MAPPING\][\s\S]*?\[END_ROLE_MAPPING\]/)?.[0] || "";
  const sceneSection = text.match(/\[START_SCENE_MAPPING\][\s\S]*?\[END_SCENE_MAPPING\]/)?.[0] || "";
  const productSection = text.match(/\[START_PRODUCT_MAPPING\][\s\S]*?\[END_PRODUCT_MAPPING\]/)?.[0] || "";
  const mapping = [roleSection, sceneSection, productSection].filter(Boolean).join("\n\n");
  const tasks = [...text.matchAll(/<VIDEO_TASK>\s*([\s\S]*?)\s*<\/VIDEO_TASK>/gi)]
    .map((match) => stringFromWorkflowValue(match[1]).trim())
    .filter(Boolean);
  if (!tasks.length) return text;
  const storyboard = tasks.map((task, index) => `第${index + 1}镜\n\n${task}`).join("\n\n");
  return [
    "[START_OUTPUT]",
    mapping,
    storyboard,
    "[END_OUTPUT]",
  ].filter(Boolean).join("\n\n");
}

function ecommerceScriptShotDetailText(content = "") {
  const text = stringFromWorkflowValue(content)
    .replace(/\[START_OUTPUT\]|\[END_OUTPUT\]|\[START_FORMAT_EXAMPLE\]|\[END_FORMAT_EXAMPLE\]/g, "")
    .trim();
  if (!text) return "";
  const match = text.match(/二、\s*分镜脚本详情[\s\S]*$/);
  return (match?.[0] || "").trim();
}

function parseEcommerceMappingImageItems(content, workflow = {}, shotAssetRefs = null) {
  const text = String(content || "");
  const assets = [
    ...parseEcommerceRoleImageItems(text),
    ...parseEcommerceSceneImageItems(text),
    ...parseEcommerceProductImageItems(text, workflow),
  ];
  const refsByShot = workflowShotAssetRefsMap(shotAssetRefs) || parseEcommerceShotAssetRefs(text);
  return attachEcommerceShotAssetRefs(assets, refsByShot);
}

function parseEcommerceRoleImageItems(text = "") {
  const body = text.match(/\[START_ROLE_MAPPING\]([\s\S]*?)\[END_ROLE_MAPPING\]/)?.[1] || "";
  return body.split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const match = line.match(/^(Role_[A-Z0-9]+)\s*[:：]\s*(.+)$/i);
      if (!match) return null;
      const roleKey = match[1];
      const value = match[2].trim();
      const { name: rawName, mapping: rawMapping } = splitEcommerceRoleMappingValue(value);
      const name = stringFromWorkflowValue(rawName).replace(/^角色库/, "") || roleKey;
      const prompt = normalizeEcommerceGeneratedRoleImagePrompt(rawMapping || value);
      return {
        id: createWorkflowLocalId(),
        index: index + 1,
        assetType: "role",
        assetRef: roleKey,
        roleKey,
        title: name,
        script: `${roleKey}: ${name}`,
        prompt,
        imagePrompt: prompt,
        matchAliases: ecommerceRoleMatchAliases({ roleKey, name, mapping: prompt }),
        imageStatus: "pending",
        imageSource: "",
        imageError: "",
        imageUrl: "",
      };
    })
    .filter((item) => item && item.prompt);
}

function splitEcommerceRoleMappingValue(value = "") {
  const text = stringFromWorkflowValue(value).trim();
  const separatorIndex = text.search(/[:：]/);
  if (separatorIndex < 0) return { name: text, mapping: "" };
  return {
    name: text.slice(0, separatorIndex).trim(),
    mapping: text.slice(separatorIndex + 1).trim(),
  };
}

function normalizeEcommerceGeneratedRoleImagePrompt(value = "") {
  return stripWorkflowRoleImageStyle(stringFromWorkflowValue(value).replace(
    /^角色库无(?:合适|匹配)?角色\s*[,，；;]?\s*(?:请)?(?:输出|生成)\s*(?:完整)?(?:的)?角色(?:图|图片|绘画)?提示词\s*[:：]?\s*/,
    "",
  ).trim());
}

function isTruncatedEcommerceGeneratedRoleImagePrompt(value = "") {
  return /^角色库无(?:合适|匹配)?角色\s*[,，；;]?\s*(?:请)?(?:输出|生成)\s*(?:完整)?(?:的)?角色(?:图|图片|绘画)?提示词\s*[:：]?\s*$/.test(
    stringFromWorkflowValue(value).trim(),
  );
}

function repairEcommerceRoleImagePrompts(shots = [], shotOutput = "") {
  const parsedRoles = parseEcommerceRoleImageItems(shotOutput);
  if (!parsedRoles.length) return shots;
  const promptByRoleRef = new Map(parsedRoles.map((role) => [
    stringFromWorkflowValue(role.assetRef || role.roleKey).trim().toLowerCase(),
    stringFromWorkflowValue(role.imagePrompt || role.prompt).trim(),
  ]));
  return shots.map((shot) => {
    if (stringFromWorkflowValue(shot?.assetType).trim().toLowerCase() !== "role") return shot;
    const roleRef = stringFromWorkflowValue(shot.assetRef || shot.roleKey).trim().toLowerCase();
    const recoveredPrompt = promptByRoleRef.get(roleRef);
    const currentPrompt = stringFromWorkflowValue(shot.imagePrompt || shot.prompt).trim();
    if (
      !recoveredPrompt
      || recoveredPrompt === currentPrompt
      || (currentPrompt && !isTruncatedEcommerceGeneratedRoleImagePrompt(currentPrompt))
    ) return shot;
    return {
      ...shot,
      prompt: recoveredPrompt,
      imagePrompt: recoveredPrompt,
    };
  });
}

function ecommerceRoleMatchAliases({ roleKey = "", name = "", libraryName = "", mapping = "", prompt = "" } = {}) {
  const values = [
    roleKey,
    name,
    libraryName,
    ...String(name || "").split(/[、,，/／\s]+/),
    ...String(libraryName || "").split(/[、,，/／\s]+/),
    ...(String(name || "").match(/[（(]([^）)]+)[）)]/g) || []).map((item) => item.replace(/[（）()]/g, "")),
    ...(String(libraryName || "").match(/[（(]([^）)]+)[）)]/g) || []).map((item) => item.replace(/[（）()]/g, "")),
  ];
  if (/老太|老人|老母亲|婆婆|奶奶|母亲|老年|银发|白发|董事长|老总/.test(`${name} ${libraryName} ${mapping} ${prompt}`)) {
    values.push("老太", "老人", "老母亲", "婆婆", "奶奶");
  }
  return [...new Set(values.map(stringFromWorkflowValue).map((item) => item.trim()).filter((item) => item && item.length >= 2))];
}

function parseEcommerceSceneImageItems(text = "") {
  const body = text.match(/\[START_SCENE_MAPPING\]([\s\S]*?)\[END_SCENE_MAPPING\]/)?.[1] || "";
  const pattern = /(?:^|\n)\s*([^\n]+?)\s*\n提示词[：:]\s*([\s\S]*?)\n场景映射[：:]\s*([^\n]+)(?=\n\s*[^\n]+?\s*\n提示词[：:]|\s*$)/g;
  const scenes = [];
  let match;
  while ((match = pattern.exec(body))) {
    const parsedTitle = parseEcommerceSceneMappingTitle(match[1], scenes.length);
    const title = cleanEcommerceAssetDisplayTitle(parsedTitle.name);
    const prompt = ensureEmptyEcommerceScenePrompt(stringFromWorkflowValue(match[2]).replace(/\n+/g, " "));
    const sceneMapping = stringFromWorkflowValue(match[3]);
    if (!title || !prompt) continue;
    scenes.push({
      id: createWorkflowLocalId(),
      index: scenes.length + 1,
      assetType: "scene",
      assetRef: parsedTitle.assetRef,
      title,
      sceneMapping,
      script: sceneMapping,
      prompt,
      imagePrompt: prompt,
      imageStatus: "pending",
      imageError: "",
      imageUrl: "",
    });
  }
  return scenes;
}

function parseEcommerceSceneMappingTitle(value = "", index = 0) {
  const text = stringFromWorkflowValue(value).trim().replace(/[：:]\s*$/, "");
  const match = text.match(/^(Scene_[A-Z0-9]+)\s*[:：\-—]\s*(.+)$/i);
  const assetRef = stringFromWorkflowValue(match?.[1] || `Scene_${String.fromCharCode(65 + Math.min(index, 25))}`);
  return {
    assetRef,
    name: stringFromWorkflowValue(match?.[2] || text || assetRef),
  };
}

function ensureEmptyEcommerceScenePrompt(prompt = "") {
  const text = stringFromWorkflowValue(prompt).trim();
  if (!text) return "";
  return /空无一人|无人|无人物|没有人物|无核心人物/.test(text) ? text : `${text}，空无一人`;
}

function cleanEcommerceAssetDisplayTitle(value = "") {
  let text = stringFromWorkflowValue(value).trim();
  for (let index = 0; index < 3; index += 1) {
    const next = text
      .replace(/^\s*[\[【「『（(]\s*/, "")
      .replace(/\s*[\]】」』）)]\s*$/, "")
      .trim();
    if (next === text) break;
    text = next;
  }
  return text;
}

function parseEcommerceProductImageItems(text = "", workflow = {}) {
  const assets = workflow?.ecommerceAssets && typeof workflow.ecommerceAssets === "object" ? workflow.ecommerceAssets : {};
  const products = Array.isArray(assets.products) ? assets.products : assets.products ? [assets.products] : [];
  const body = String(text || "").match(/\[START_PRODUCT_MAPPING\]([\s\S]*?)\[END_PRODUCT_MAPPING\]/)?.[1] || "";
  const productMappings = parseEcommerceProductMappings(body);
  return products
    .map((asset, index) => {
      const profile = asset?.productProfile && typeof asset.productProfile === "object" ? asset.productProfile : {};
      const assetRef = `Product_${index + 1}`;
      const mappedName = productMappings[index]?.name || productMappings.find((item) => item.assetRef === assetRef)?.name || "";
      const title = stringFromWorkflowValue(asset?.name || profile.productName || profile["产品名称"] || mappedName || `商品 ${index + 1}`);
      const imageUrl = resolveFlowStudioFileUrl(asset?.productImageUrl || profile.productImageUrl || asset?.imageUrl || asset?.fileUrl || asset?.url || "");
      const imageThumbnailUrl = resolveFlowStudioFileUrl(asset?.productImageThumbnailUrl || profile.productImageThumbnailUrl || asset?.imageThumbnailUrl || asset?.thumbnailUrl || asset?.thumbUrl || "");
      const prompt = stringFromWorkflowValue(asset?.prompt || profile.productHighlights || profile["产品亮点"] || title);
      return {
        id: createWorkflowLocalId(),
        index: index + 1,
        assetType: "product",
        assetId: stringFromWorkflowValue(asset?.id || asset?.assetId),
        productAssetId: stringFromWorkflowValue(asset?.id || asset?.assetId),
        assetRef,
        title,
        script: `产品图：产品库[${title}]`,
        prompt,
        imagePrompt: prompt,
        imageStatus: imageUrl ? "done" : "error",
        imageSource: "product-library",
        imageError: imageUrl ? "" : "产品库未上传商品图",
        imageUrl,
        imageThumbnailUrl,
      };
    })
    .filter((item) => item.title || item.imageUrl);
}

function parseEcommerceProductMappings(body = "") {
  return stringFromWorkflowValue(body)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const productMatch = line.match(/^(Product_\d+)\s*[:：]\s*(.+)$/i);
      const legacyMatch = line.match(/^产品图[：:]\s*(.+)$/);
      const assetRef = stringFromWorkflowValue(productMatch?.[1] || `Product_${index + 1}`);
      const value = stringFromWorkflowValue(productMatch?.[2] || legacyMatch?.[1] || line);
      if (/未选择带货产品/.test(value)) return null;
      return {
        assetRef,
        name: cleanEcommerceProductMappingName(value),
      };
    })
    .filter(Boolean);
}

function cleanEcommerceProductMappingName(value = "") {
  return stringFromWorkflowValue(value)
    .replace(/^产品库\s*/, "")
    .replace(/^[\[【「『（(]\s*/, "")
    .replace(/\s*[\]】」』）)]$/, "")
    .trim();
}

function parseEcommerceShotAssetRefs(text = "") {
  const body = String(text || "").match(/\[START_SHOT_ASSET_MAPPING\]([\s\S]*?)\[END_SHOT_ASSET_MAPPING\]/)?.[1] || "";
  const refsByShot = new Map();
  const pattern = /(?:^|\n)\s*第\s*(\d+)\s*镜\s*[：:]\s*([\s\S]*?)(?=\n\s*第\s*\d+\s*镜\s*[：:]|$)/g;
  let match;
  while ((match = pattern.exec(body))) {
    const shotIndex = Number(match[1]) || 0;
    const block = stringFromWorkflowValue(match[2]);
    if (!shotIndex || !block) continue;
    refsByShot.set(shotIndex, {
      sceneRefs: parseEcommerceAssetRefLine(block, ["场景图", "场景参考", "场景"]),
      roleRefs: parseEcommerceAssetRefLine(block, ["角色图", "角色"]),
      productRefs: parseEcommerceAssetRefLine(block, ["产品图", "商品图", "产品", "商品"]),
    });
  }
  return refsByShot;
}

function workflowShotAssetRefsMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value)
    .map(([shotIndex, refs]) => {
      const index = Number(shotIndex) || 0;
      if (!index || !refs || typeof refs !== "object" || Array.isArray(refs)) return null;
      return [index, {
        sceneRefs: Array.isArray(refs.sceneRefs) ? refs.sceneRefs.map(stringFromWorkflowValue).filter(Boolean) : [],
        roleRefs: Array.isArray(refs.roleRefs) ? refs.roleRefs.map(stringFromWorkflowValue).filter(Boolean) : [],
        productRefs: Array.isArray(refs.productRefs) ? refs.productRefs.map(stringFromWorkflowValue).filter(Boolean) : [],
      }];
    })
    .filter(Boolean);
  return entries.length ? new Map(entries) : null;
}

function workflowShotAssetRefsObject(refsByShot = new Map()) {
  if (!refsByShot.size) return {};
  return Object.fromEntries(
    [...refsByShot.entries()]
      .sort(([left], [right]) => Number(left) - Number(right))
      .map(([shotIndex, refs]) => [String(shotIndex), {
        sceneRefs: Array.isArray(refs.sceneRefs) ? refs.sceneRefs : [],
        roleRefs: Array.isArray(refs.roleRefs) ? refs.roleRefs : [],
        productRefs: Array.isArray(refs.productRefs) ? refs.productRefs : [],
      }])
  );
}

function parseEcommerceAssetRefLine(block = "", labels = []) {
  const labelPattern = labels.map(escapeWorkflowRegExp).join("|");
  const match = block.match(new RegExp(`(?:^|\\n)\\s*(?:${labelPattern})\\s*[：:]\\s*([^\\n]+)`, "i"));
  const value = stringFromWorkflowValue(match?.[1] || "");
  if (!value || /^(无|没有|暂无|未选择|none|null)$/i.test(value)) return [];
  return value
    .split(/[\s,，、;；|/／]+/)
    .map(cleanEcommerceAssetRefValue)
    .filter(Boolean);
}

function cleanEcommerceAssetRefValue(value = "") {
  const text = stringFromWorkflowValue(value)
    .replace(/^产品库\s*/, "")
    .replace(/^[\[【「『（(]\s*/, "")
    .replace(/\s*[\]】」』）)]$/, "")
    .trim();
  return /^(无|没有|暂无|未选择|none|null)$/i.test(text) ? "" : text;
}

function attachEcommerceShotAssetRefs(assets = [], refsByShot = new Map()) {
  if (!refsByShot.size) return assets;
  return assets.map((asset) => {
    const shotRefs = [];
    refsByShot.forEach((refs, shotIndex) => {
      if (ecommerceAssetReferencedByShot(asset, refs)) shotRefs.push(shotIndex);
    });
    return shotRefs.length ? { ...asset, shotRefs } : asset;
  });
}

function ecommerceAssetReferencedByShot(asset = {}, refs = {}) {
  const key = asset.assetType === "role"
    ? "roleRefs"
    : asset.assetType === "scene"
      ? "sceneRefs"
      : asset.assetType === "product"
        ? "productRefs"
        : "";
  const refsForType = key && Array.isArray(refs[key]) ? refs[key] : [];
  if (!refsForType.length) return false;
  const aliases = ecommerceAssetRefAliases(asset).map(normalizeWorkflowAssetMatchText).filter(Boolean);
  return refsForType.some((ref) => {
    if (workflowStructuredAssetRefMatches(asset, ref)) return true;
    const refKey = normalizeWorkflowAssetMatchText(ref);
    if (!refKey || asset.assetType === "role" || workflowLooksLikeStructuredAssetRef(refKey)) return false;
    return aliases.some((alias) => alias.includes(refKey) || refKey.includes(alias));
  });
}

function ecommerceAssetRefAliases(asset = {}) {
  return [
    asset.assetRef,
    asset.roleKey,
    asset.title,
    asset.name,
    asset.assetType === "product" && asset.title ? `产品库[${asset.title}]` : "",
    asset.assetType === "product" && asset.index ? `Product_${asset.index}` : "",
    asset.assetType === "scene" && asset.index ? `Scene_${String.fromCharCode(64 + Math.min(Number(asset.index) || 1, 26))}` : "",
  ].map(stringFromWorkflowValue).filter(Boolean);
}

function workflowShotAssetReferenceModel(run = {}, summary = {}, rawShotText = "") {
  const explicitRefs = workflowShotAssetRefsMap(summary.shotAssetRefs) || workflowShotAssetRefsMap(run.shotAssetRefs);
  const parsedRefs = parseEcommerceShotAssetRefs(rawShotText);
  const assetRefs = workflowShotAssetRefsFromAssets(summary.shots || run.shots || []);
  const refsByShot = explicitRefs || (parsedRefs.size ? parsedRefs : assetRefs);
  const assets = workflowShotAssetInventory(summary.shots || run.shots || [], refsByShot);
  const rows = [...refsByShot.entries()]
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([shotIndex, refs]) => {
      const scenes = workflowAssetRefDescriptors(refs.sceneRefs, assets, "scene");
      const roles = workflowAssetRefDescriptors(refs.roleRefs, assets, "role");
      const products = workflowAssetRefDescriptors(refs.productRefs, assets, "product");
      const unresolved = [...scenes, ...roles, ...products].filter((item) => !item.resolved);
      return {
        shotIndex,
        scenes,
        roles,
        products,
        status: unresolved.length ? "需检查" : "正常",
        statusTone: unresolved.length ? "warn" : "ok",
      };
    });
  return {
    rows,
    assets,
    raw: workflowShotAssetRefsRawPayload(refsByShot, assets),
  };
}

function workflowShotAssetRefsFromAssets(shots = []) {
  const refsByShot = new Map();
  workflowShotAssetInventory(shots).forEach((asset) => {
    asset.shotRefs.forEach((shotIndex) => {
      const current = refsByShot.get(shotIndex) || { sceneRefs: [], roleRefs: [], productRefs: [] };
      const key = asset.assetType === "scene" ? "sceneRefs" : asset.assetType === "role" ? "roleRefs" : asset.assetType === "product" ? "productRefs" : "";
      if (key && asset.assetRef && !current[key].includes(asset.assetRef)) current[key].push(asset.assetRef);
      refsByShot.set(shotIndex, current);
    });
  });
  return refsByShot;
}

function workflowShotAssetInventory(shots = [], refsByShot = null) {
  const refsObject = workflowShotAssetRefsObject(refsByShot || new Map());
  return (Array.isArray(shots) ? shots : [])
    .filter((shot) => ["scene", "role", "product"].includes(shot?.assetType))
    .map((shot, index) => {
      const assetType = stringFromWorkflowValue(shot.assetType);
      const assetRef = workflowShotAssetRef(shot, index);
      const title = stringFromWorkflowValue(shot.title || shot.name || shot.roleKey || shot.sceneMapping || "");
      const explicitShotRefs = Array.isArray(shot.shotRefs)
        ? shot.shotRefs.map(Number).filter((item) => Number.isFinite(item) && item > 0)
        : [];
      const inferredShotRefs = explicitShotRefs.length ? explicitShotRefs : Object.entries(refsObject)
        .filter(([, refs]) => {
          const key = assetType === "scene" ? "sceneRefs" : assetType === "role" ? "roleRefs" : "productRefs";
          return Array.isArray(refs[key]) && refs[key].some((ref) => normalizeWorkflowAssetMatchText(ref) === normalizeWorkflowAssetMatchText(assetRef));
        })
        .map(([shotIndex]) => Number(shotIndex))
        .filter((item) => Number.isFinite(item) && item > 0);
      return {
        assetType,
        assetRef,
        title,
        shotRefs: [...new Set(inferredShotRefs)].sort((left, right) => left - right),
      };
    })
    .filter((asset) => asset.assetType && asset.assetRef);
}

function workflowShotAssetRef(shot = {}, index = 0) {
  const assetRef = stringFromWorkflowValue(shot.assetRef || "");
  if (assetRef) return assetRef;
  if (shot.assetType === "role") return stringFromWorkflowValue(shot.roleKey || `Role_${String.fromCharCode(65 + Math.min(index, 25))}`);
  if (shot.assetType === "product") return `Product_${Number(shot.index || index + 1) || index + 1}`;
  if (shot.assetType === "scene") return `Scene_${String.fromCharCode(65 + Math.min(Number(shot.index || index + 1) - 1 || index, 25))}`;
  return "";
}

function workflowManualOutfitRoleOptions(run = {}, summary = {}) {
  const shots = Array.isArray(run.shots) ? run.shots : Array.isArray(summary.shots) ? summary.shots : [];
  return shots
    .filter((shot) => shot?.assetType === "role" && !workflowShotIsOutfitVariant(shot))
    .map((shot, index) => ({
      ...shot,
      assetRef: workflowShotAssetRef(shot, index),
      title: stringFromWorkflowValue(shot.title || shot.name || shot.roleKey || workflowShotAssetRef(shot, index)),
    }))
    .filter((shot) => shot.assetRef);
}

function workflowManualOutfitShotOptions(run = {}, summary = {}) {
  const storyboardSources = [
    summary.shotOutput,
    run.shotOutput,
    workflowShotText(run),
    summary.script,
  ].map(stringFromWorkflowValue).filter(Boolean);
  const storyboard = storyboardSources
    .map((source) => ecommerceStoryboardShots(source))
    .find((items) => items.length) || [];
  if (storyboard.length) {
    return storyboard.map((shot) => ({
      index: Number(shot.index),
      title: stringFromWorkflowValue(shot.heading || shot.title || shot.text).slice(0, 96),
      text: stringFromWorkflowValue(shot.text).slice(0, 160),
    })).filter((shot) => Number.isFinite(shot.index) && shot.index > 0);
  }
  const refsByShot = workflowShotAssetRefsMap(summary.shotAssetRefs) || workflowShotAssetRefsMap(run.shotAssetRefs) || workflowShotAssetRefsFromAssets(summary.shots || run.shots || []);
  return [...refsByShot.keys()]
    .map(Number)
    .filter((index) => Number.isFinite(index) && index > 0)
    .sort((left, right) => left - right)
    .map((index) => ({ index, title: `第 ${index} 镜`, text: "" }));
}

function buildWorkflowManualOutfitShotMatchPrompt({ baseRole = {}, variantName = "", outfitPrompt = "", shots = [], script = "" } = {}) {
  const shotLines = (Array.isArray(shots) ? shots : [])
    .map((shot) => `第${shot.index}镜：${shot.title || ""}\n${shot.text || ""}`.trim())
    .join("\n\n");
  return `请判断下列分镜中，哪些镜头应该使用指定角色的变装版本。

判断规则：
1. 只选择镜头画面里明确需要该角色处于“${variantName}”或符合变装描述的镜头。
2. 如果镜头仍然是基础角色原本状态，不要选择。
3. 如果镜头没有出现该基础角色，不要选择。
4. 只返回 JSON，不要解释。

返回格式：
{"shotIndexes":[1,2,3]}

【基础角色】
${baseRole.title || baseRole.name || baseRole.roleKey || baseRole.assetRef || "角色"}
${baseRole.imagePrompt || baseRole.prompt || ""}

【变装版本】
版本名：${variantName}
变装描述：${outfitPrompt}

【分镜列表】
${shotLines || "无"}

【完整文案参考】
${script || ""}`;
}

function buildWorkflowManualOutfitVariantAsset(baseRole = {}, variant = {}, existingShots = []) {
  const baseAssetRef = workflowShotAssetRef(baseRole, 0);
  const variantRef = workflowNextManualOutfitAssetRef(baseAssetRef, existingShots);
  const variantName = stringFromWorkflowValue(variant.variantName).trim();
  const outfitPrompt = stringFromWorkflowValue(variant.outfitPrompt).trim();
  const shotRefs = uniqueWorkflowNumberList(variant.shotRefs);
  const prompt = buildWorkflowManualOutfitVariantPrompt(baseRole, { outfitPrompt });
  const roleIndex = Math.max(0, ...existingShots.filter((shot) => shot?.assetType === "role").map((shot) => Number(shot.index) || 0)) + 1;
  const title = `${stringFromWorkflowValue(baseRole.title || baseRole.name || baseRole.roleKey || baseAssetRef) || "角色"}_${variantName}`;
  const id = createWorkflowLocalId();
  return {
    ...baseRole,
    id,
    shotId: id,
    index: roleIndex,
    assetType: "role",
    assetRef: variantRef,
    roleKey: variantRef,
    title,
    script: `${variantRef}: ${title}`,
    prompt,
    imagePrompt: prompt,
    matchAliases: [
      variantRef,
      title,
      variantName,
      baseRole.title,
      baseRole.roleKey,
      ...(Array.isArray(baseRole.matchAliases) ? baseRole.matchAliases : []),
    ].map(stringFromWorkflowValue).filter(Boolean),
    imageStatus: "pending",
    imageSource: "manual-outfit-variant",
    imageError: "",
    imageUrl: "",
    imageThumbnailUrl: "",
    thumbnailUrl: "",
    thumbUrl: "",
    fileUrl: "",
    url: "",
    image: {},
    result: {},
    shotRefs,
    outfitVariantOf: baseAssetRef,
    outfitVariantName: variantName,
    manualOutfitVariant: true,
  };
}

function buildWorkflowManualOutfitVariantPrompt(baseRole = {}, variant = {}) {
  const basePrompt = stringFromWorkflowValue(baseRole.imagePrompt || baseRole.prompt || baseRole.description);
  const baseName = stringFromWorkflowValue(baseRole.title || baseRole.roleKey || "角色");
  return [
    `保持与原角色“${baseName}”同一角色身份、核心五官、脸型、发型关联、身材比例和人物气质`,
    `仅改变指定的服装、年龄阶段或视觉状态：${stringFromWorkflowValue(variant.outfitPrompt)}`,
    basePrompt ? `原角色基础提示词：${basePrompt}` : "",
    "单人全身角色参考图，无表情，双手自然下垂，纯灰白色无缝摄影棚背景，背景中没有任何物体或人物",
  ].filter(Boolean).join("，");
}

function workflowNextManualOutfitAssetRef(baseAssetRef = "", shots = []) {
  const base = stringFromWorkflowValue(baseAssetRef).replace(/[^a-zA-Z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "Role";
  const pattern = new RegExp(`^${escapeWorkflowRegExp(base)}_Outfit_(\\d+)$`, "i");
  const used = (Array.isArray(shots) ? shots : [])
    .map((shot) => stringFromWorkflowValue(shot.assetRef || shot.roleKey))
    .map((ref) => Number(ref.match(pattern)?.[1] || 0))
    .filter((value) => Number.isFinite(value) && value > 0);
  return `${base}_Outfit_${Math.max(0, ...used) + 1}`;
}

function workflowShotAssetRefsWithManualOutfitVariant(run = {}, summary = {}, baseRole = {}, variantAsset = {}, shotRefs = []) {
  const refsByShot = workflowShotAssetRefsMap(summary.shotAssetRefs)
    || workflowShotAssetRefsMap(run.shotAssetRefs)
    || workflowShotAssetRefsFromAssets(summary.shots || run.shots || []);
  const nextRefsByShot = new Map([...refsByShot.entries()].map(([shotIndex, refs]) => [Number(shotIndex), {
    sceneRefs: Array.isArray(refs.sceneRefs) ? [...refs.sceneRefs] : [],
    roleRefs: Array.isArray(refs.roleRefs) ? [...refs.roleRefs] : [],
    productRefs: Array.isArray(refs.productRefs) ? [...refs.productRefs] : [],
  }]));
  uniqueWorkflowNumberList(shotRefs).forEach((shotIndex) => {
    const refs = nextRefsByShot.get(shotIndex) || { sceneRefs: [], roleRefs: [], productRefs: [] };
    const currentRoleRefs = Array.isArray(refs.roleRefs) ? refs.roleRefs : [];
    const replaced = currentRoleRefs.map((ref) => workflowAssetRefMatchesShot(baseRole, ref) ? variantAsset.assetRef : ref);
    refs.roleRefs = replaced.some((ref) => normalizeWorkflowAssetMatchText(ref) === normalizeWorkflowAssetMatchText(variantAsset.assetRef))
      ? replaced
      : [...replaced, variantAsset.assetRef];
    nextRefsByShot.set(shotIndex, refs);
  });
  return nextRefsByShot;
}

function workflowAssetRefMatchesShot(asset = {}, ref = "") {
  return workflowStructuredAssetRefMatches(asset, ref);
}

function workflowStructuredAssetRefMatches(asset = {}, ref = "") {
  const refKey = normalizeWorkflowAssetMatchText(ref);
  if (!refKey) return false;
  return workflowStructuredAssetAliases(asset)
    .map(normalizeWorkflowAssetMatchText)
    .filter(Boolean)
    .some((alias) => alias === refKey);
}

function workflowStructuredAssetAliases(asset = {}) {
  return [
    asset.assetRef,
    asset.roleKey,
    asset.title,
    asset.name,
    ...(Array.isArray(asset.matchAliases) ? asset.matchAliases : []),
    asset.assetType === "product" && asset.title ? `产品库[${asset.title}]` : "",
    asset.assetType === "product" && asset.index ? `Product_${asset.index}` : "",
    asset.assetType === "scene" && asset.index ? `Scene_${String.fromCharCode(64 + Math.min(Number(asset.index) || 1, 26))}` : "",
  ].map(stringFromWorkflowValue).filter(Boolean);
}

function workflowLooksLikeStructuredAssetRef(value = "") {
  return /^(role|scene|product)_/i.test(normalizeWorkflowAssetMatchText(value));
}

function uniqueWorkflowNumberList(values = []) {
  return [...new Set((Array.isArray(values) ? values : [values])
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0))]
    .sort((left, right) => left - right);
}

function workflowAssetRefDescriptors(refs = [], assets = [], assetType = "") {
  return (Array.isArray(refs) ? refs : []).map((ref) => {
    const normalized = normalizeWorkflowAssetMatchText(ref);
    const asset = assets.find((item) => item.assetType === assetType && normalizeWorkflowAssetMatchText(item.assetRef) === normalized)
      || assets.find((item) => item.assetType === assetType && normalizeWorkflowAssetMatchText(item.title) === normalized);
    return {
      ref,
      title: asset?.title || "",
      resolved: Boolean(asset),
    };
  });
}

function workflowShotAssetRefsRawPayload(refsByShot = new Map(), assets = []) {
  return {
    mode: "ecommerce_shot_asset_refs",
    schema_version: 1,
    shot_asset_refs: workflowShotAssetRefsObject(refsByShot),
    scene_assets: workflowShotAssetRawAssets(assets, "scene", "scene_id"),
    role_assets: workflowShotAssetRawAssets(assets, "role", "role_id"),
    product_assets: workflowShotAssetRawAssets(assets, "product", "product_id"),
  };
}

function workflowShotAssetRawAssets(assets = [], assetType = "", idKey = "asset_id") {
  return assets
    .filter((asset) => asset.assetType === assetType)
    .map((asset) => ({
      [idKey]: asset.assetRef,
      name: asset.title,
      shot_numbers: asset.shotRefs,
    }));
}

function cleanupWorkflowShotText(value = "") {
  return String(value)
    .replace(/\[END_OUTPUT\][\s\S]*$/g, "")
    .replace(/\[START_OUTPUT\]/g, "")
    .trim();
}

function createWorkflowLocalId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `shot-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function firstWorkflowArray(...values) {
  const found = values.find((value) => Array.isArray(value));
  return found || [];
}

function isTopicConfirmationRun(run) {
  return run?.kind === "topic-seed" || run?.kind === "main";
}

function workflowBackHref(run) {
  return run?.workflowId ? `/workflows?workflowId=${encodeURIComponent(run.workflowId)}` : "/workflows";
}

function workflowRunOwnerName(run) {
  return run?.workflowName || run?.workflow?.name || run?.name || run?.topic || "工作流";
}

function workflowTopicTitleOnly(value = "") {
  const text = cleanWorkflowTopicOutline(value).trim();
  if (!text) return "未命名任务";
  const firstLine = text
    .replace(/\[START_TOPIC_EXAMPLE\]|\[END_TOPIC_EXAMPLE\]/g, "")
    .split(/\n+/)
    .map((line) => line.trim())
    .find((line) => {
      const cleanLine = line.replace(/^\s*\d+[、.．)]\s*/, "").trim();
      return cleanLine && !/^(?:\[?选题标题\]?|【选题标题】)\s*[:：]?\s*$/.test(cleanLine) && !/^【(?:开场场景|故事梗概)】/.test(cleanLine);
    }) || text;
  return firstLine
    .replace(/^\s*\d+[、.．)]\s*/, "")
    .replace(/^(?:\[?选题标题\]?|【选题标题】)\s*[:：]?\s*/, "")
    .trim() || "未命名任务";
}

function workflowRunShortId(run) {
  const id = run?.serial || run?.number || run?.id || "";
  if (!id) return "未记录";
  return String(id).length > 8 ? String(id).slice(-6) : String(id);
}

function workflowTopicOptions(run, summary) {
  const generated = Array.isArray(run?.generatedTopics) ? run.generatedTopics : [];
  const selected = Array.isArray(run?.selectedTopics) ? run.selectedTopics : [];
  const confirmed = Array.isArray(run?.confirmedTopics) ? run.confirmedTopics : [];
  const source = generated.length ? generated : [...confirmed, ...selected, ...summary.topics];
  return uniqueWorkflowTextList(source.map(cleanWorkflowTopicOutline).filter(Boolean));
}

function workflowTopicAdaptationsForTopics(run, topics = []) {
  return topics.reduce((adaptations, topic) => {
    const adaptation = workflowTopicAdaptationFor(run, topic);
    if (adaptation) adaptations[topic] = adaptation;
    return adaptations;
  }, {});
}

function workflowTopicAdaptationFor(run, topic) {
  const direct = stringFromWorkflowValue(run?.topicAdaptation);
  if (direct && normalizeWorkflowTopicTitle(run?.topic) === normalizeWorkflowTopicTitle(topic)) return direct;
  const adaptations = objectFromWorkflowValue(run?.topicAdaptations || run?.result?.topicAdaptations);
  const title = stringFromWorkflowValue(topic);
  if (title && stringFromWorkflowValue(adaptations[title])) return stringFromWorkflowValue(adaptations[title]);
  const key = normalizeWorkflowTopicTitle(title);
  const matched = Object.entries(adaptations).find(([candidate]) => normalizeWorkflowTopicTitle(candidate) === key);
  return matched ? stringFromWorkflowValue(matched[1]) : "";
}

function renameWorkflowTopicAdaptation(run, oldTopic, nextTopic) {
  const adaptations = { ...objectFromWorkflowValue(run?.topicAdaptations || run?.result?.topicAdaptations) };
  const adaptation = workflowTopicAdaptationFor(run, oldTopic);
  const oldKey = Object.keys(adaptations).find((candidate) => normalizeWorkflowTopicTitle(candidate) === normalizeWorkflowTopicTitle(oldTopic));
  if (oldKey) delete adaptations[oldKey];
  if (adaptation) adaptations[nextTopic] = adaptation;
  return adaptations;
}

function workflowDefaultSelectedIndexes(run, topics) {
  const confirmedTopicKeys = new Set(
    (Array.isArray(run?.confirmedTopics) ? uniqueWorkflowTextList(run.confirmedTopics) : [])
      .map(normalizeWorkflowTopicTitle),
  );
  const selected = Array.isArray(run?.selectedTopics) ? uniqueWorkflowTextList(run.selectedTopics) : [];
  const topicKeys = topics.map(normalizeWorkflowTopicTitle);
  const picked = selected
    .map((topic) => topicKeys.indexOf(normalizeWorkflowTopicTitle(topic)))
    .filter((index) => index >= 0 && !confirmedTopicKeys.has(topicKeys[index]));
  return picked;
}

function normalizeWorkflowTopicTitle(value) {
  return cleanWorkflowTopicOutline(value).trim().replace(/\s+/g, " ").toLowerCase();
}

function cleanWorkflowTopicOutline(value = "") {
  const lines = stringFromWorkflowValue(value)
    .replace(/\[START_TOPIC_EXAMPLE\]|\[END_TOPIC_EXAMPLE\]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n");
  const firstIndex = lines.findIndex((line) => line.trim());
  if (firstIndex < 0) return "";
  const firstLine = lines[firstIndex].trim();
  const numberPrefix = firstLine.match(/^(\s*\d+[、.．)]\s*)/)?.[1] || "";
  const firstText = firstLine.replace(/^\s*\d+[、.．)]\s*/, "").trim();
  const placeholder = firstText.match(/^(?:\[?选题标题\]?|【选题标题】)\s*[:：]?\s*(.*)$/);
  if (!placeholder) return lines.join("\n").trim();

  const inlineTitle = String(placeholder[1] || "").trim();
  if (inlineTitle && !/^(?:\[?选题标题\]?|【选题标题】)$/.test(inlineTitle)) {
    lines[firstIndex] = `${numberPrefix}${inlineTitle}`.trim();
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  const nextTitleIndex = lines.findIndex((line, index) => {
    const text = line.trim();
    return index > firstIndex && text && !/^【(?:开场场景|故事梗概)】/.test(text);
  });
  if (nextTitleIndex > firstIndex) {
    lines[firstIndex] = `${numberPrefix}${lines[nextTitleIndex].trim()}`.trim();
    lines.splice(nextTitleIndex, 1);
  } else {
    lines.splice(firstIndex, 1);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function workflowRunHasLiveJob(run) {
  const backendJobs = run.backendJobs && typeof run.backendJobs === "object" ? run.backendJobs : {};
  const activeStage = Object.keys(run.stages || {}).some((stageId) => workflowNodeIsRunning(run, stageId));
  const runIsActive = ["running", "queued"].includes(run.status);
  const activeBackendJob = Object.entries(backendJobs).some(([nodeId, job]) => (
    ["running", "queued"].includes(job?.status)
    && !(nodeId === "videoSubmit" && !workflowVideoResultsHaveActiveTask(run?.videoResults))
    && !workflowNodeHasFinishedOutput(run, nodeId)
    && !(nodeId === "draft" && workflowDraftHasFailed(run))
    && (runIsActive || nodeId === "draft")
  ));
  const activeTopicGeneration = runIsActive && run.topicGenerationStatus === "running" && !workflowNodeHasFinishedOutput(run, "topic");
  return activeTopicGeneration || activeStage || activeBackendJob;
}

function workflowNodeIsRunning(run, nodeId) {
  if (nodeId === "image") {
    const shots = Array.isArray(run?.shots) ? run.shots : [];
    if (shots.some((shot) => !workflowShotImageUrl(shot) && ["running", "queued"].includes(shot.imageStatus))) return true;
    const imageJobStatus = run?.backendJobs?.image?.status || "";
    return ["running", "queued"].includes(run?.status) && ["running", "queued"].includes(imageJobStatus) && !workflowNodeHasFinishedOutput(run, "image");
  }
  if (nodeId === "video" && Array.isArray(run?.videoResults) && run.videoResults.length) {
    return workflowVideoResultsHaveActiveTask(run.videoResults);
  }
  if (nodeId === "audio" && workflowNodeActiveStatus(run, nodeId)) return true;
  const stageStatus = run?.stages?.[nodeId] || "";
  const jobStatus = run?.backendJobs?.[nodeId]?.status || "";
  if (nodeId === "draft" && workflowDraftHasFailed(run)) return false;
  if (nodeId === "draft" && ["running", "queued"].includes(jobStatus)) return true;
  if (workflowNodeHasFinishedOutput(run, nodeId)) return false;
  if (!["running", "queued"].includes(run?.status)) return false;
  return ["running", "queued"].includes(stageStatus) || ["running", "queued"].includes(jobStatus);
}

function workflowDraftHasFailed(run = {}) {
  const draft = objectFromWorkflowValue(run?.draft);
  return Boolean(run?.draftError || draft.error)
    || ["error", "failed", "canceled"].includes(String(run?.draftStatus || draft.status || "").toLowerCase())
    || ["error", "failed", "canceled"].includes(String(run?.stages?.draft || "").toLowerCase())
    || ["error", "failed", "canceled"].includes(String(run?.backendJobs?.draft?.status || "").toLowerCase());
}

function workflowStageIds(workflow = null) {
  return orderWorkflowStageIds(["topic", "outline", "script", "optimize", "shot", "image", "audio", "videoPrompt", "video", "draft"], workflow);
}

function workflowStageIndex(stageId, workflow = null) {
  return workflowStageIds(workflow).indexOf(stageId);
}

function workflowDownstreamStages(stageId, workflow = null) {
  const stages = workflowStageIds(workflow);
  const index = workflowStageIndex(stageId, workflow);
  return index < 0 ? [] : stages.slice(index + 1);
}

function workflowHasTouchedAfterStage(run, stageId, workflow = null) {
  const downstream = workflowDownstreamStages(stageId, workflow);
  return downstream.some((stage) => {
    const status = run?.stages?.[stage];
    return status && status !== "pending";
  }) || workflowHasArtifactsAfterStage(run, stageId, workflow);
}

function workflowHasArtifactsAfterStage(run, stageId, workflow = null) {
  if (stageId === "image") {
    const hasAudio = !isTalkingVideoWorkflow(workflow) && Boolean(run?.audioUrl || run?.audio?.audio_url || run?.audioSegments?.length || run?.audioTracks?.length);
    return hasAudio || Boolean(run?.videoTimeline?.length || run?.videoResults?.length || run?.videoPackageStatus);
  }
  if (stageId === "videoPrompt") return Boolean(run?.videoResults?.length || run?.stages?.video !== "pending" || run?.videoPackageStatus);
  return false;
}

function workflowNodeHasFinishedOutput(run, stageId) {
  if (stageId === "image") {
    const shots = (Array.isArray(run?.shots) ? run.shots : []).filter(workflowShotRequiresGeneratedImage);
    return shots.length > 0 && shots.every((shot) => workflowShotImageUrl(shot));
  }
  return workflowStageHasOutput(run, stageId);
}

function workflowStageHasOutput(run, stageId) {
  if (stageId === "topic") return Boolean((run?.generatedTopics || []).length || (run?.selectedTopics || []).length || (run?.confirmedTopics || []).length);
  if (stageId === "script") return Boolean(stringFromWorkflowValue(run?.scriptOutput || run?.script || run?.content));
  if (stageId === "optimize") return Boolean(stringFromWorkflowValue(run?.scriptTranslation || run?.optimizedScript || run?.optimizedOutput || run?.optimizationOutput));
  if (stageId === "audio") return Boolean(run?.audioUrl || run?.audio?.audio_url || (Array.isArray(run?.audioSegments) && run.audioSegments.length) || (Array.isArray(run?.audioTracks) && run.audioTracks.length));
  if (stageId === "shot") return Boolean(stringFromWorkflowValue(run?.shotOutput) || (Array.isArray(run?.shots) && run.shots.length));
  if (stageId === "image") return Array.isArray(run?.shots) && run.shots.some((shot) => workflowShotRequiresGeneratedImage(shot) && workflowShotImageUrl(shot));
  if (stageId === "videoPrompt") return workflowVideoPromptStageHasOutput(run);
  if (stageId === "video") {
    const videoStatus = workflowVideoStageFromResults(run?.videoResults, run?.videoTimeline);
    if (videoStatus !== "pending") return videoStatus === "done";
    if (Array.isArray(run?.videoTimeline) && run.videoTimeline.length) return false;
    return ["done", "completed"].includes(run?.videoStatus);
  }
  if (stageId === "draft") return Boolean(run?.draftUrl || run?.draft?.draft_url || run?.draft?.url || run?.draftStatus === "done");
  return false;
}

function workflowTimelineHasVideoPrompts(timeline = []) {
  return Array.isArray(timeline) && timeline.some((item) => stringFromWorkflowValue(item?.videoPrompt).trim());
}

function workflowVideoPromptStageHasOutput(run = {}) {
  const storyboard = isStoryboardWorkflow(run?.workflowSnapshot || run?.workflowConfig || run?.result?.workflowSnapshot || run?.result?.workflowConfig || run);
  if (storyboard) return workflowTimelineHasVideoPrompts(run?.videoTimeline);
  return Array.isArray(run?.videoTimeline) && run.videoTimeline.length > 0;
}

function workflowOptimizeStageForAudio(run, summary = {}) {
  const status = run?.stages?.optimize || "";
  if (status && !["pending", "waiting"].includes(status)) return status;
  return summary.optimizedScript || workflowStageHasOutput(run, "optimize") ? "done" : "skipped";
}

function workflowStageStatus(run, stageId) {
  const explicitStatus = run?.stages?.[stageId] || "";
  if (stageId === "audio") {
    const activeStatus = workflowNodeActiveStatus(run, stageId);
    if (activeStatus) return activeStatus;
  }
  if (stageId === "video") {
    const videoStatus = workflowVideoStageFromResults(run?.videoResults, run?.videoTimeline);
    if (videoStatus !== "pending") return videoStatus;
    if (Array.isArray(run?.videoTimeline) && run.videoTimeline.length) {
      if (["running", "queued", "error", "failed", "partial"].includes(run?.videoStatus)) return run.videoStatus;
      if (["running", "queued", "error", "failed", "partial"].includes(explicitStatus)) return explicitStatus;
      return "pending";
    }
    if (["running", "queued", "error", "failed", "partial"].includes(run?.videoStatus)) return run.videoStatus;
    if (["running", "queued", "error", "failed", "partial"].includes(explicitStatus)) return explicitStatus;
    return "pending";
  }
  if (stageId === "image") {
    const shots = (Array.isArray(run?.shots) ? run.shots : []).filter(workflowShotRequiresGeneratedImage);
    const hasShots = shots.length > 0;
    const hasRunningShot = shots.some((shot) => !workflowShotImageUrl(shot) && ["running", "queued"].includes(shot.imageStatus));
    const imageJobStatus = run?.backendJobs?.image?.status || "";
    const missingCount = shots.filter((shot) => !workflowShotImageUrl(shot)).length;
    if (hasRunningShot || (["running", "queued"].includes(run?.status) && ["running", "queued"].includes(imageJobStatus))) return "running";
    if (hasShots && !missingCount) return "done";
    if (hasShots && missingCount && ["done", "error", "running", "queued"].includes(explicitStatus)) return "error";
  }
  if (workflowStageHasOutput(run, stageId)) return "done";
  if (explicitStatus) return explicitStatus;
  return "pending";
}

function workflowResultTabs(workflow = null) {
  const tabs = [
    { id: "script", label: "文案结果" },
    { id: "optimize", label: "优化" },
    { id: "shot", label: "分镜结果" },
    { id: "image", label: "分镜图片" },
    { id: "audio", label: "音频" },
    { id: "video", label: "视频制作" },
    { id: "videoResult", label: "视频结果" },
  ];
  const visibleTabs = isStoryboardWorkflow(workflow) ? tabs.filter((tab) => tab.id !== "audio") : tabs;
  const tabById = new Map(visibleTabs.map((tab) => [tab.id, tab]));
  return orderWorkflowStageIds(visibleTabs.map((tab) => tab.id), workflow).map((tabId) => tabById.get(tabId)).filter(Boolean);
}

function isEcommerceWorkflow(workflow = null) {
  return String(workflow?.type || workflow?.workflowType || workflow?.config?.type || "").trim() === "ecommerce";
}

function isStoryWorkflow(workflow = null) {
  return String(workflow?.type || workflow?.workflowType || workflow?.config?.type || "").trim() === "story";
}

function isStoryboardWorkflow(workflow = null) {
  return isEcommerceWorkflow(workflow) || isStoryWorkflow(workflow);
}

const workflowCopyLanguageLabels = {
  zh: "中文",
  en: "英文",
  de: "德语",
  fr: "法语",
  ja: "日语",
  ko: "韩语",
  id: "印尼语",
  pt: "葡萄牙语",
  es: "西班牙语",
};

function workflowConfiguredLanguage(workflow = {}) {
  const language = stringFromWorkflowValue(workflow?.workflow?.language || workflow?.language || workflow?.config?.language).trim().toLowerCase();
  return workflowCopyLanguageLabels[language] ? language : "zh";
}

function workflowReadingLanguage(language = "zh") {
  return language === "en" ? "en" : "zh";
}

function workflowCopyLanguageLabel(language = "zh") {
  return workflowCopyLanguageLabels[language] || workflowCopyLanguageLabels.zh;
}

function workflowTranslationTargetLabel(readingLanguage = "zh") {
  return workflowCopyLanguageLabel(workflowReadingLanguage(readingLanguage));
}

function workflowTranslationAudienceLabel(readingLanguage = "zh") {
  return workflowReadingLanguage(readingLanguage) === "zh" ? "中文受众" : "英语受众";
}

async function requestWorkflowTranslation(workflow, text, kind, readingLanguage = "zh") {
  const targetLanguage = workflowTranslationTargetLabel(readingLanguage);
  const audience = workflowTranslationAudienceLabel(readingLanguage);
  const prompt = kind === "script"
    ? `把这篇文案翻译成符合${audience}阅读习惯的${targetLanguage}，不得改变原文的意思，不得增加或减少原文的内容，文案如下：\n${text}`
    : `把这段文字翻译成符合${audience}阅读习惯的${targetLanguage}，不得改变原文的意思，不得增加或减少原文的内容，文案如下：\n${text}`;
  const result = await generateText({
    apiKeyId: workflow.llmKeyId,
    channel: workflow.llmChannel || workflow.llmProvider || "",
    model: workflow.storyModelId,
    messages: [
      { role: "system", content: "你是一名专业译者。只输出翻译后的正文，不要输出解释、标题或额外说明。" },
      { role: "user", content: prompt },
    ],
  });
  const content = extractWorkflowLlmContent(result?.data || result);
  if (!content) throw new Error("AI 已返回，但没有解析到翻译内容。");
  return content;
}

async function requestWorkflowComplianceReview(workflow, text) {
  const result = await generateText({
    apiKeyId: workflow.llmKeyId,
    channel: workflow.llmChannel || workflow.llmProvider || "",
    model: workflow.storyModelId,
    taskType: "workflow-script-compliance-review",
    messages: [
      { role: "system", content: "你是内容安全审查员。严格执行用户提供的红灯和黄灯规则，只返回合法 JSON。不要输出 Markdown、代码块或额外解释。" },
      { role: "user", content: buildWorkflowCompliancePrompt(text) },
    ],
  });
  const content = extractWorkflowLlmContent(result?.data || result);
  if (!content) throw new Error("AI 已返回，但没有解析到违规风险检测结果。");
  const parsed = parseWorkflowJsonObject(content);
  if (!Array.isArray(parsed?.issues)) throw new Error("AI 返回的违规风险报告格式不正确，请重试。");
  return { issues: normalizeWorkflowComplianceIssues(parsed, text) };
}

async function requestWorkflowScriptOptimization(workflow, text, instruction) {
  const result = await generateText({
    apiKeyId: workflow.llmKeyId,
    channel: workflow.llmChannel || workflow.llmProvider || "",
    model: workflow.storyModelId,
    taskType: "workflow-script-custom-optimization",
    messages: [
      { role: "system", content: "你是专业文案优化编辑。严格根据用户的优化要求修改完整文案，保留未要求改变的事实、人物关系、结构化标记和输出格式。优化后的完整正文必须以 [START_FORMAT_EXAMPLE] 作为第一行，并以 [END_FORMAT_EXAMPLE] 作为最后一行；这两个完整性边界标识必须原样保留且不得重复。只输出优化后的完整正文，不要解释、标题、Markdown 代码块或修改摘要。" },
      { role: "user", content: `优化要求：\n${instruction}\n\n当前完整文案：\n${text}` },
    ],
  });
  const content = cleanupWorkflowGeneratedScript(extractWorkflowLlmContent(result?.data || result));
  if (!content) throw new Error("AI 已返回，但没有解析到优化后的完整文案。");
  return content;
}

function cleanupWorkflowGeneratedScript(value = "") {
  const text = String(value || "").trim();
  const fenced = text.match(/^```(?:text|markdown|md)?\s*([\s\S]*?)```$/i)?.[1];
  return String(fenced || text).trim();
}

function extractWorkflowLlmContent(data) {
  const message = data?.choices?.[0]?.message;
  if (typeof message?.content === "string") return message.content.trim();
  if (Array.isArray(message?.content)) {
    return message.content
      .map((part) => part.text || part.content || "")
      .join("\n")
      .trim();
  }
  return String(data?.choices?.[0]?.text || data?.output_text || data?.content || "").trim();
}

function parseWorkflowJsonObject(value = "") {
  const text = stringFromWorkflowValue(value).trim();
  if (!text) return {};
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidates = [
    fenced,
    text,
    text.match(/\{[\s\S]*\}/)?.[0],
    text.match(/\[[\s\S]*\]/)?.[0],
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return { shotIndexes: parsed };
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      // Try the next candidate.
    }
  }
  return {};
}

function workflowShotImageUrl(shot) {
  if (!shot || typeof shot !== "object") return "";
  return resolveFlowStudioFileUrl(shot.imageUrl || shot.fileUrl || shot.url || shot.image?.url || shot.result?.url || "");
}

function workflowShotRequiresGeneratedImage(shot) {
  return Boolean(shot);
}

function workflowShotThumbnailUrl(shot) {
  if (!shot || typeof shot !== "object") return "";
  return resolveFlowStudioFileUrl(shot.imageThumbnailUrl || shot.thumbnailUrl || shot.thumbUrl || shot.image?.thumbnailUrl || shot.result?.thumbnailUrl || "");
}

function workflowImagePreviewUrl(src) {
  const url = resolveFlowStudioFileUrl(src);
  if (!url || url.startsWith("data:image/")) return url;
  return url;
}

function workflowTimelineImageUrl(item) {
  if (!item || typeof item !== "object") return "";
  return resolveFlowStudioFileUrl(item.imageUrl || item.fileUrl || item.url || item.image?.url || "");
}

function workflowVideoUrl(video) {
  if (!video) return "";
  if (typeof video === "string") return resolveFlowStudioFileUrl(video);
  return resolveFlowStudioFileUrl(video.videoUrl || video.url || video.fileUrl || video.outputUrl || video.downloadUrl || video.result?.url || "");
}

function workflowPackageUrl(value) {
  if (!value) return "";
  if (typeof value === "string") return resolveFlowStudioFileUrl(value);
  return resolveFlowStudioFileUrl(value.packageUrl || value.zipUrl || value.url || value.fileUrl || value.outputUrl || "");
}

function workflowShotNumber(shot, index) {
  return String(Number(shot?.index || shot?.shotIndex || index + 1) || index + 1).padStart(2, "0");
}

function ecommerceSceneMappingShotLabels(value) {
  const text = stringFromWorkflowValue(value);
  if (!text) return [];
  const labels = [];
  const seen = new Set();
  const pattern = /第\s*(\d+)\s*镜/g;
  let match;
  while ((match = pattern.exec(text))) {
    const number = Number(match[1]);
    if (!Number.isFinite(number) || number <= 0) continue;
    const label = `第${number}镜`;
    if (seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
  }
  if (labels.length) return labels;
  return text
    .split(/[、,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 80);
}

function workflowShotId(shot) {
  return stringFromWorkflowValue(shot?.id || shot?.shotId || shot?.uuid || "");
}

function workflowShotStatus(shot, imageUrl, run = null) {
  if (shot?.imageStatus === "paused") return "等待已暂停";
  if (shot?.imageStatus === "error" || shot?.imageError) return "生成失败";
  if (["queued", "running"].includes(shot?.imageStatus)) return "生成中";
  if (imageUrl) return "已生成";
  if (run && workflowNodeIsRunning(run, "image")) return "生成中";
  if (run && workflowStageStatus(run, "image") === "error") return "生成失败";
  return "等待生成";
}

function workflowShotIsOutfitVariant(shot = {}) {
  if (!shot || typeof shot !== "object") return false;
  if (stringFromWorkflowValue(shot.outfitVariantOf || shot.outfitVariantName)) return true;
  return stringFromWorkflowValue(shot.imageSource || shot.source || shot.imageOrigin) === "role-outfit-variant";
}

function workflowRoleOutfitVariantSummary(run = {}) {
  const stored = objectFromWorkflowValue(run.roleOutfitVariantSummary);
  const storedStatus = stringFromWorkflowValue(run.roleOutfitVariantStatus || stored.status);
  const hasStoredSummary = Boolean(storedStatus || Object.keys(stored).length);
  const variantShots = (Array.isArray(run.shots) ? run.shots : []).filter(workflowShotIsOutfitVariant);
  if (!hasStoredSummary && !variantShots.length) return null;

  const generatedShots = variantShots.filter((shot) => workflowShotImageUrl(shot) && shot.imageStatus !== "error");
  const failedShots = variantShots.filter((shot) => shot.imageStatus !== "paused" && (shot.imageStatus === "error" || shot.imageError));
  const pendingShots = variantShots.filter((shot) => !generatedShots.includes(shot) && !failedShots.includes(shot));
  let status = storedStatus;
  if (variantShots.length) {
    if (failedShots.length && (generatedShots.length || pendingShots.length)) status = "partial";
    else if (failedShots.length) status = "error";
    else if (pendingShots.length) status = "pending";
    else status = "done";
  } else if (!status) {
    status = stored.enabled === false ? "skipped" : "none";
  }

  const variantTitles = variantShots.length
    ? variantShots.map((shot) => stringFromWorkflowValue(shot.title || shot.roleKey || shot.assetRef)).filter(Boolean)
    : Array.isArray(stored.variantTitles) ? stored.variantTitles : [];
  return {
    ...stored,
    enabled: stored.enabled === undefined ? status !== "skipped" : Boolean(stored.enabled),
    status,
    variantCount: variantShots.length || Number(stored.variantCount) || 0,
    generatedCount: generatedShots.length || Number(stored.generatedCount) || 0,
    pendingCount: pendingShots.length || Number(stored.pendingCount) || 0,
    failedCount: failedShots.length || Number(stored.failedCount) || 0,
    variantTitles,
  };
}

function workflowRoleOutfitVariantMessage(summary = {}) {
  const status = stringFromWorkflowValue(summary.status);
  const variantCount = Number(summary.variantCount) || 0;
  const generatedCount = Number(summary.generatedCount) || 0;
  const pendingCount = Number(summary.pendingCount) || 0;
  const failedCount = Number(summary.failedCount) || 0;
  if (status === "skipped") {
    return summary.reason === "missing_detector" ? "变装检测：未执行，请检查检测 LLM 渠道和模型" : "变装检测：未启用";
  }
  if (status === "none") return "变装检测：未检测到需要补齐的变装角色图";
  if (status === "done") return `变装检测：已补齐 ${variantCount} 个角色版本，图片已生成`;
  if (status === "pending") return `变装检测：已补齐 ${variantCount} 个角色版本，${pendingCount || variantCount} 张等待生成`;
  if (status === "partial") return `变装检测：已补齐 ${variantCount} 个角色版本，${generatedCount} 张已生成，${failedCount} 张生成失败`;
  if (status === "error") return `变装检测：已补齐 ${variantCount} 个角色版本，图片生成失败`;
  return "";
}

function workflowOutfitVariantStatusFromShot(shot = {}, statusLabel = "") {
  if (shot.imageStatus === "paused" || statusLabel === "等待已暂停") return "pending";
  if (shot.imageStatus === "error" || shot.imageError || statusLabel === "生成失败") return "error";
  if (workflowShotImageUrl(shot)) return "done";
  return "pending";
}

function workflowOutfitVariantTone(status = "") {
  const value = stringFromWorkflowValue(status);
  if (value === "done") return "ok";
  if (value === "error") return "error";
  if (value === "partial" || value === "pending") return "warn";
  if (value === "none") return "neutral";
  return "muted";
}

function workflowEcommerceImageSourceLabel(shot = {}, status = "") {
  const assetType = stringFromWorkflowValue(shot.assetType);
  const source = stringFromWorkflowValue(shot.imageSource || shot.source || shot.imageOrigin).toLowerCase();
  if (assetType === "product") return "产品库复用";
  if (assetType === "role" && source === "manual-upload") return "本地上传";
  if (assetType === "role" && workflowShotIsOutfitVariant(shot)) return "变装补齐";
  if (assetType === "role" && workflowEcommerceRoleLibrarySource(shot)) return "角色库复用";
  if (assetType === "role" && workflowShotImageUrl(shot)) return "AI 生成";
  return status || "等待生成";
}

function workflowEcommerceRoleLibrarySource(shot = {}) {
  const source = stringFromWorkflowValue(shot.imageSource || shot.source || shot.imageOrigin).toLowerCase();
  if (["role-library", "library", "asset-library"].includes(source)) return true;
  if (source === "ai-generated") return false;
  return Boolean(workflowShotImageUrl(shot) && stringFromWorkflowValue(shot.roleReferenceImageId));
}

function workflowLlmModelOptions(apiKey) {
  if (!apiKey) return [];
  const knownModels = llmModelsForApiKey(apiKey);
  if (knownModels.length) return knownModels;
  return workflowCustomModelOptions(apiKey.model);
}

function workflowImageModelOptions(apiKey) {
  if (!apiKey) return [];
  const knownModels = imageModelsForApiKey(apiKey, { workflow: true });
  if (knownModels.length) return knownModels;
  return workflowCustomModelOptions(apiKey.model).map((model) => ({
    ...model,
    resolutions: ["默认"],
    ratios: defaultWorkflowImageRatios(),
  }));
}

function workflowAudioModelOptions(apiKey) {
  return (apiKey?.modelOptions || []).map(model => ({ ...model, name: model.name || model.id }));
}

function workflowVideoModelOptions(apiKey) {
  if (!apiKey) return [];
  return videoModelsForApiKey(apiKey, { workflow: true });
}

function workflowVideoModelCandidates(apiKeys = []) {
  return (Array.isArray(apiKeys) ? apiKeys : []).flatMap((apiKey) =>
    workflowVideoModelOptions(apiKey).map((model) => ({ apiKey, model })));
}

function workflowVideoSelectedCandidate(dialog = {}, apiKeys = []) {
  const candidates = workflowVideoModelCandidates(apiKeys);
  if (!candidates.length) return null;
  return candidates.find((candidate) => (
    candidate.apiKey.id === dialog.apiKeyId
    && candidate.model.id === dialog.modelId
  )) || candidates.find((candidate) => candidate.apiKey.id === dialog.apiKeyId) || candidates[0];
}

function workflowCustomModelOptions(value = "") {
  return String(value)
    .split(/[,，;\n]/)
    .map((model) => model.trim())
    .filter(Boolean)
    .map((model) => ({ id: model, name: model }));
}

function defaultWorkflowImageRatios() {
  return [
    { value: "1:1", label: "正方形", detail: "1:1" },
    { value: "9:16", label: "竖屏", detail: "9:16" },
    { value: "16:9", label: "横屏", detail: "16:9" },
    { value: "21:9", label: "超宽屏", detail: "21:9" },
  ];
}

function workflowImageRatioOptions(model) {
  const ratios = model?.ratios?.length ? model.ratios : defaultWorkflowImageRatios();
  return ratios.map((ratio) => ({
    value: ratio.value || ratio.id || ratio,
    label: ratio.label || ratio.name || ratio.value || ratio,
    detail: ratio.detail || ratio.value || ratio.id || ratio,
  }));
}

function workflowImageRequestSize(ratio = "") {
  const value = String(ratio || "").trim().toLowerCase().replace(/\s+/g, "").replace(/[×*]/g, "x");
  return /^\d{3,4}x\d{3,4}$/.test(value) ? value : "";
}

function optionValueOrFirst(options, value) {
  if (options.includes(value)) return value;
  return options[0] || "";
}

function workflowVideoOptionFirstValue(options = []) {
  const first = (Array.isArray(options) ? options : [])[0];
  return typeof first === "string" ? first : first?.value || first?.id || "";
}

function workflowVideoOptionValue(options = [], value = "") {
  const option = (Array.isArray(options) ? options : []).find((item) => (
    typeof item === "string" ? item === value : [item.value, item.id].includes(value)
  ));
  if (!option) return "";
  return typeof option === "string" ? option : option.value || option.id || "";
}

function apiKeyDisplayName(apiKey) {
  return apiKey?.name || formatApiChannelName(apiKey?.channel) || apiKey?.serviceType || "未命名渠道";
}

function normalizeWorkflowProviderName(value = "") {
  return stringFromWorkflowValue(value).replace(/\s+/g, "").toLowerCase();
}

function formatApiChannelName(channel = "") {
  const value = stringFromWorkflowValue(channel);
  if (/^canvas$/i.test(value)) return "Canvas";
  return value;
}

function workflowShotText(run) {
  if (run?.shotOutput?.trim()) return run.shotOutput.trim();
  const shots = Array.isArray(run?.shots) ? run.shots : [];
  return shots
    .map((shot, index) => {
      const shotNumber = workflowShotNumber(shot, index);
      const script = stringFromWorkflowValue(shot.script || shot.copy || shot.voiceover || shot.narration);
      const prompt = stringFromWorkflowValue(shot.imagePrompt || shot.prompt || shot.description || shot.text);
      return `【镜头${shotNumber}】\n对应文案：\n${script}\n画面提示词：\n${prompt}`;
    })
    .join("\n\n");
}

function workflowParsedShotOutput(run) {
  const raw = stringFromWorkflowValue(run?.shotOutput).trim();
  if (!raw) return [];
  return parseWorkflowShots(raw).map((shot, index) => ({
    index: Number(shot.index || index + 1),
    script: stringFromWorkflowValue(shot.script),
    prompt: stringFromWorkflowValue(shot.prompt || shot.imagePrompt || shot.description),
  }));
}

function workflowVideoSegmentAssets(item) {
  if (Array.isArray(item?.assets) && item.assets.length) {
    const assets = item.assets
      .map((asset, assetIndex) => {
        const assetType = stringFromWorkflowValue(asset.assetType || asset.type || "");
        const title = stringFromWorkflowValue(asset.title || asset.name || asset.roleKey || asset.sceneMapping || "");
        return {
          index: Number(asset.index || item.startIndex || item.index || assetIndex + 1) || assetIndex + 1,
          title: assetType === "scene" ? cleanEcommerceAssetDisplayTitle(title) : title,
          assetType,
          assetRef: stringFromWorkflowValue(asset.assetRef || ""),
          roleKey: stringFromWorkflowValue(asset.roleKey || ""),
          matchAliases: Array.isArray(asset.matchAliases) ? asset.matchAliases.map(stringFromWorkflowValue).filter(Boolean) : [],
          shotRefs: Array.isArray(asset.shotRefs) ? asset.shotRefs.map(Number).filter((shotRef) => Number.isFinite(shotRef) && shotRef > 0) : [],
          imageUrl: resolveFlowStudioFileUrl(asset.imageUrl || asset.fileUrl || asset.url || ""),
          thumbnailUrl: resolveFlowStudioFileUrl(asset.imageThumbnailUrl || asset.thumbnailUrl || asset.thumbUrl || ""),
          imagePrompt: stringFromWorkflowValue(asset.imagePrompt || asset.prompt || asset.description),
        };
      })
      .filter((asset) => asset.imageUrl);
    if (item?.ecommerceStoryboard) {
      const rawText = stringFromWorkflowValue(item.storyboardDetail || item.script || item.title);
      const textKey = normalizeWorkflowAssetMatchText(rawText);
      return sortWorkflowVideoAssetsByFileName(
        assets.filter((asset) => asset.assetType !== "product" || workflowEcommerceTimelineProductAssetMatchesShot(asset, item, textKey, rawText)),
        workflowVideoAssetDownloadFileName,
      );
    }
    return assets;
  }
  const imageUrl = workflowTimelineImageUrl(item);
  if (!imageUrl) return [];
  return [{
    index: Number(item.startIndex || item.index) || 1,
    title: stringFromWorkflowValue(item.title || item.name || ""),
    assetType: stringFromWorkflowValue(item.assetType || ""),
    assetRef: stringFromWorkflowValue(item.assetRef || ""),
    roleKey: stringFromWorkflowValue(item.roleKey || ""),
    matchAliases: Array.isArray(item.matchAliases) ? item.matchAliases.map(stringFromWorkflowValue).filter(Boolean) : [],
    shotRefs: Array.isArray(item.shotRefs) ? item.shotRefs.map(Number).filter((shotRef) => Number.isFinite(shotRef) && shotRef > 0) : [],
    imageUrl,
    thumbnailUrl: resolveFlowStudioFileUrl(item.imageThumbnailUrl || item.thumbnailUrl || item.thumbUrl || ""),
    imagePrompt: stringFromWorkflowValue(item.imagePrompt || item.prompt || item.description),
  }];
}

function workflowVideoTimelineItemWithoutAsset(item = {}, targetAsset = {}) {
  const previousAutoPrompt = workflowVideoSegmentPrompt(item).trim();
  const existingPrompt = stringFromWorkflowValue(item.videoPrompt).trim();
  const hasAssetList = Array.isArray(item.assets);
  const rawAssets = hasAssetList ? item.assets : [item];
  let removed = false;
  const assets = rawAssets.filter((asset) => {
    if (removed || !workflowVideoAssetMatchesTarget(asset, targetAsset)) return true;
    removed = true;
    return false;
  });
  if (!removed) return item;
  const previewItem = {
    ...item,
    assets,
    imageUrl: "",
    fileUrl: "",
    url: "",
    imageThumbnailUrl: "",
    thumbnailUrl: "",
    thumbUrl: "",
  };
  const displayAssets = workflowVideoSegmentAssets(previewItem);
  const firstAsset = displayAssets[0] || {};
  const nextAutoPrompt = workflowVideoSegmentPrompt(previewItem).trim();
  const nextVideoPrompt = !existingPrompt || existingPrompt === previousAutoPrompt ? nextAutoPrompt : existingPrompt;
  return {
    ...item,
    assets: hasAssetList ? assets : [],
    imageUrl: firstAsset.imageUrl || "",
    fileUrl: "",
    url: "",
    imageThumbnailUrl: firstAsset.thumbnailUrl || "",
    thumbnailUrl: firstAsset.thumbnailUrl || "",
    thumbUrl: "",
    imagePrompt: item.ecommerceStoryboard ? item.imagePrompt : displayAssets.map((asset) => asset.imagePrompt).filter(Boolean).join("\n\n"),
    videoPrompt: nextVideoPrompt,
  };
}

function workflowVideoAssetMatchesTarget(asset = {}, target = {}) {
  const assetUrl = resolveFlowStudioFileUrl(asset.imageUrl || asset.fileUrl || asset.url || "");
  const targetUrl = resolveFlowStudioFileUrl(target.imageUrl || target.fileUrl || target.url || "");
  if (!assetUrl || !targetUrl || assetUrl !== targetUrl) return false;
  const assetType = stringFromWorkflowValue(asset.assetType || asset.type);
  const targetType = stringFromWorkflowValue(target.assetType || target.type);
  if (assetType && targetType && assetType !== targetType) return false;
  const assetRef = stringFromWorkflowValue(asset.assetRef || asset.roleKey || asset.shotId);
  const targetRef = stringFromWorkflowValue(target.assetRef || target.roleKey || target.shotId);
  return !assetRef || !targetRef || assetRef === targetRef;
}

function workflowVideoSegmentLabel(item, index = 0) {
  if (item?.ecommerceStoryboard && item.title) return item.title;
  const assets = workflowVideoSegmentAssets(item);
  const firstIndex = Number(item?.startIndex || assets[0]?.index || item?.index || index + 1) || index + 1;
  const lastIndex = Number(item?.endIndex || assets[assets.length - 1]?.index || firstIndex) || firstIndex;
  const first = String(firstIndex).padStart(2, "0");
  const last = String(lastIndex).padStart(2, "0");
  return first === last ? `分镜 ${first}` : `分镜 ${first}-${last}`;
}

function workflowVideoAssetDisplayName(asset = {}, index = 0) {
  const rawTitle = stringFromWorkflowValue(asset.title || asset.name || asset.roleKey || "").trim();
  const title = asset.assetType === "scene" ? cleanEcommerceAssetDisplayTitle(rawTitle) : rawTitle;
  if (title) return title;
  const typeLabel = asset.assetType === "role" ? "角色" : asset.assetType === "scene" ? "场景" : asset.assetType === "product" ? "商品" : "图片";
  return `${typeLabel}${String(index + 1).padStart(2, "0")}`;
}

function workflowVideoAssetDownloadFileName(asset = {}, index = 0) {
  const name = safeWorkflowVideoDownloadName(workflowVideoAssetDisplayName(asset, index), "图片");
  return `${name}.${workflowImageExtensionFromSource(asset.imageUrl)}`;
}

function workflowVideoSegmentPrompt(item) {
  const storyboardDetail = stringFromWorkflowValue(item?.storyboardDetail || item?.script);
  if (item?.videoPromptMode === "ai-director") {
    return buildWorkflowAiDirectorVideoPrompt({
      assets: workflowVideoSegmentAssets(item),
      voiceBindings: item.voiceBindings,
      beats: item.videoPromptBeats,
    });
  }
  if (item?.ecommerceStoryboard) return workflowEcommerceVideoSegmentPrompt(item);
  const assets = workflowVideoSegmentAssets(item);
  if (!assets.length) return "";
  if (assets.length === 1) return assets[0].imagePrompt || "";
  return assets
    .map((asset) => `图片 ${String(asset.index).padStart(2, "0")}：${asset.imagePrompt || ""}`.trim())
    .join("\n\n");
}

function workflowEcommerceVideoSegmentPrompt(item) {
  const storyboardDetail = stringFromWorkflowValue(item?.storyboardDetail || item?.script);
  const assets = workflowVideoSegmentAssets(item);
  const imageLabel = (asset) => {
    const assetIndex = assets.findIndex((candidate) => candidate.imageUrl === asset.imageUrl && candidate.assetType === asset.assetType);
    return `@图片${assetIndex + 1}`;
  };
  const scenes = assets.filter((asset) => asset.assetType === "scene");
  const roles = assets.filter((asset) => asset.assetType === "role");
  const products = assets.filter((asset) => asset.assetType === "product");
  const sceneLine = scenes.length
    ? scenes.map((asset) => `${imageLabel(asset)} ${asset.title || "场景图"}`).join("，")
    : "无";
  const roleLine = roles.length
    ? roles.map((asset) => `${imageLabel(asset)} ${asset.title || "角色"}`).join("，")
    : "无";
  const productLine = products.length
    ? products.map((asset) => `${imageLabel(asset)} ${asset.title || "商品"}`).join("，")
    : "无";
  const roleAndProductLine = [
    roles.length ? roleLine : "",
    products.length ? productLine : "",
  ].filter(Boolean).join("，") || "无";
  return [
    `场景参考：${sceneLine}`,
    `角色：${roleAndProductLine}`,
    "",
    "剧情：",
    storyboardDetail || "暂无分镜脚本",
    "",
    "规则：",
    "- 画面平滑过渡，参考图片中的场景与构图和表现力",
    "- 禁止添加字幕、标签或标注",
    "- 不要生成任何背景音乐（BGM）或配乐",
    "- 单镜头同角色唯一：同一镜头中同一角色只能出现一个实体，禁止分身、克隆、镜像替身、并排双人同角或同帧重复出现在画面中",
    "- 运镜设计要丰富多样，符合短视频审美节奏",
    "- 风格：真人电影质感，禁止任何艺术画风，自然镜头过渡，统一色调",
    "- 去掉人物脸部和身上的所有彩绘效果、素描效果和绘画效果，保持真人皮肤质感和真实的衣物质感",
    "- 必须保持写实、真实摄影、真人实拍的视觉表达，禁止插画、动漫、油画、水彩、CG、3D 渲染或任何艺术转绘感",
  ].join("\n");
}

function workflowFinalScriptText(summary = {}) {
  return stringFromWorkflowValue(summary.script).trim();
}

function workflowAudioTracksFromRun(run = {}) {
  const explicitTracks = firstWorkflowArray(run?.audioTracks);
  const tracks = explicitTracks.map(normalizeWorkflowAudioTrack).filter(Boolean);
  if (tracks.length) return tracks;
  const legacyAudio = objectFromWorkflowValue(run?.audio);
  const legacyUrl = stringFromWorkflowValue(legacyAudio.audio_url || legacyAudio.audioUrl || run?.audioUrl).trim();
  const legacySegments = firstWorkflowArray(legacyAudio.segments, run?.audioSegments);
  const legacyRawSegments = firstWorkflowArray(legacyAudio.raw_segments, legacyAudio.rawSegments, run?.audioRawSegments);
  if (!legacyUrl && !legacySegments.length && !legacyRawSegments.length) return [];
  return [normalizeWorkflowAudioTrack({
    id: legacyAudio.id || "legacy-audio",
    variant: legacyAudio.variant || "voice",
    source: legacyAudio.source || "generated",
    label: legacyAudio.label || "口播音频",
    audio_url: legacyUrl,
    duration: Number(legacyAudio.duration || run?.audioDuration || 0),
    rawSegments: legacyRawSegments,
    segments: legacySegments,
    subtitle_srt: legacyAudio.subtitle_srt || run?.subtitleSrt || "",
    ...(legacyAudio.subtitle_status || legacyAudio.subtitleStatus || (legacyRawSegments.length && !legacySegments.length) ? {
      subtitleStatus: legacyAudio.subtitle_status || legacyAudio.subtitleStatus || "pending",
    } : {}),
    parts: legacyAudio.parts || [],
  })].filter(Boolean);
}

function normalizeWorkflowAudioTrack(track = {}) {
  const parts = firstWorkflowArray(track.parts).map(normalizeWorkflowAudioPart).filter(Boolean);
  const fallbackAudioUrl = stringFromWorkflowValue(track.audio_url || track.audioUrl || track.url).trim();
  const fallbackDuration = Number(track.duration || track.audioDuration || 0);
  const normalizedParts = parts.length ? parts : (fallbackAudioUrl ? [{
    id: `${track.id || "audio"}-part-1`,
    index: 1,
    name: track.name || "第 1 段",
    audio_url: fallbackAudioUrl,
    duration: fallbackDuration,
    ...(firstWorkflowArray(track.rawSegments, track.raw_segments).length ? {
      rawSegments: firstWorkflowArray(track.rawSegments, track.raw_segments),
    } : {}),
    segments: firstWorkflowArray(track.segments),
    subtitle_srt: stringFromWorkflowValue(track.subtitle_srt || track.subtitleSrt),
    ...(track.subtitleStatus || track.subtitle_status ? {
      subtitleStatus: track.subtitleStatus || track.subtitle_status,
    } : {}),
  }] : []);
  const rawSegments = normalizeWorkflowAudioSegments(firstWorkflowArray(track.rawSegments, track.raw_segments), track.script || "", fallbackDuration);
  const partRawSegments = normalizedParts.flatMap((part) => firstWorkflowArray(part.rawSegments));
  const hasRawTiming = rawSegments.length > 0 || partRawSegments.length > 0;
  const finalRawSegments = rawSegments.length ? rawSegments : normalizeWorkflowAudioSegments(partRawSegments, track.script || "", fallbackDuration);
  const segments = normalizeWorkflowAudioSegments(firstWorkflowArray(track.segments), track.script || "", fallbackDuration);
  const partSegments = normalizedParts.flatMap((part) => firstWorkflowArray(part.segments));
  const explicitSubtitleStatus = stringFromWorkflowValue(track.subtitleStatus || track.subtitle_status);
  const subtitlePending = explicitSubtitleStatus === "pending"
    || (!explicitSubtitleStatus && hasRawTiming && !segments.length && !partSegments.length && !stringFromWorkflowValue(track.subtitle_srt || track.subtitleSrt));
  const finalSegments = subtitlePending
    ? []
    : segments.length ? segments : normalizeWorkflowAudioSegments(partSegments, track.script || "", fallbackDuration);
  const duration = Number(track.duration || normalizedParts.reduce((sum, part) => sum + Number(part.duration || 0), 0) || finalSegments.at(-1)?.end || finalRawSegments.at(-1)?.end || 0);
  const variant = String(track.variant || "voice");
  const audioUrl = fallbackAudioUrl || normalizedParts[0]?.audio_url || "";
  if (!audioUrl && !finalSegments.length) return null;
  return {
    id: String(track.id || `${variant}-${track.source || "audio"}-${Date.now()}`),
    variant,
    source: String(track.source || "generated"),
    label: stringFromWorkflowValue(track.label) || workflowAudioTrackLabel(variant),
    script: stringFromWorkflowValue(track.script),
    audio_url: audioUrl,
    duration: roundWorkflowTime(duration),
    ...(hasRawTiming ? { rawSegments: finalRawSegments } : {}),
    segments: finalSegments,
    subtitle_srt: subtitlePending ? "" : stringFromWorkflowValue(track.subtitle_srt || track.subtitleSrt) || workflowSegmentsToSrt(finalSegments),
    ...(explicitSubtitleStatus || subtitlePending ? { subtitleStatus: subtitlePending ? "pending" : explicitSubtitleStatus } : {}),
    alignment: normalizeWorkflowAudioAlignment(track.alignment || normalizedParts.find((part) => part.alignment)?.alignment),
    parts: normalizedParts,
    createdAt: track.createdAt || "",
    updatedAt: track.updatedAt || "",
  };
}

function normalizeWorkflowAudioPart(part = {}, index = 0) {
  const audioUrl = resolveFlowStudioFileUrl(part.audio_url || part.audioUrl || part.url || part.fileUrl || "");
  if (!audioUrl) return null;
  const segments = firstWorkflowArray(part.segments);
  const rawSegments = firstWorkflowArray(part.rawSegments, part.raw_segments);
  return {
    id: String(part.id || `part-${index + 1}-${audioUrl}`),
    index: Number(part.index || index + 1),
    name: stringFromWorkflowValue(part.name) || `第 ${Number(part.index || index + 1)} 段`,
    text: stringFromWorkflowValue(part.text),
    audio_url: audioUrl,
    duration: roundWorkflowTime(Number(part.duration || part.audioDuration || segments.at(-1)?.end || rawSegments.at(-1)?.end || 0)),
    ...(rawSegments.length ? { rawSegments } : {}),
    segments,
    subtitle_srt: stringFromWorkflowValue(part.subtitle_srt || part.subtitleSrt),
    ...(part.subtitleStatus || part.subtitle_status ? {
      subtitleStatus: stringFromWorkflowValue(part.subtitleStatus || part.subtitle_status),
    } : {}),
    alignment: normalizeWorkflowAudioAlignment(part.alignment),
  };
}

function buildWorkflowAudioTrack({ variant = "voice", source = "generated", script = "", parts = [], replaceId = "", subtitleStatus = "final" } = {}) {
  const normalizedParts = parts.map(normalizeWorkflowAudioPart).filter(Boolean);
  let cursor = 0;
  const rawSegments = [];
  const segments = [];
  normalizedParts.forEach((part, partIndex) => {
    const normalizedRawSegments = normalizeWorkflowAudioSegments(firstWorkflowArray(part.rawSegments, part.segments), part.text || "", part.duration);
    const fallbackRawSegments = normalizedRawSegments.length ? normalizedRawSegments : estimateWorkflowAudioSegments(part.text || "", part.duration);
    const normalizedFinalSegments = subtitleStatus === "pending"
      ? []
      : normalizeWorkflowAudioSegments(part.segments, part.text || "", part.duration);
    rawSegments.push(...fallbackRawSegments.map((segment) => ({
      ...segment,
      index: 0,
      start: roundWorkflowTime(cursor + Number(segment.start || 0)),
      end: roundWorkflowTime(cursor + Number(segment.end || 0)),
    })));
    segments.push(...normalizedFinalSegments.map((segment) => ({
      ...segment,
      index: 0,
      start: roundWorkflowTime(cursor + Number(segment.start || 0)),
      end: roundWorkflowTime(cursor + Number(segment.end || 0)),
    })));
    const partDuration = Number(part.duration || fallbackRawSegments.at(-1)?.end || normalizedFinalSegments.at(-1)?.end || 0);
    cursor = roundWorkflowTime(cursor + partDuration);
    normalizedParts[partIndex] = {
      ...part,
      duration: roundWorkflowTime(partDuration),
      ...(subtitleStatus === "pending" ? { rawSegments: fallbackRawSegments } : {}),
      segments: normalizedFinalSegments,
      subtitle_srt: subtitleStatus === "pending" ? "" : part.subtitle_srt || workflowSegmentsToSrt(normalizedFinalSegments),
      ...(subtitleStatus === "pending" ? { subtitleStatus } : {}),
    };
  });
  const indexedRawSegments = rawSegments.map((segment, index) => ({ ...segment, index: index + 1 }));
  const indexedSegments = segments.map((segment, index) => ({ ...segment, index: index + 1 }));
  const duration = roundWorkflowTime(normalizedParts.reduce((sum, part) => sum + Number(part.duration || 0), 0) || indexedSegments.at(-1)?.end || indexedRawSegments.at(-1)?.end || 0);
  return {
    id: replaceId || `${variant}-${source}-${Date.now()}`,
    variant,
    source,
    label: workflowAudioTrackLabel(variant),
    script: stringFromWorkflowValue(script),
    audio_url: normalizedParts[0]?.audio_url || "",
    duration,
    ...(subtitleStatus === "pending" ? { rawSegments: indexedRawSegments } : {}),
    segments: indexedSegments,
    subtitle_srt: subtitleStatus === "pending" ? "" : workflowSegmentsToSrt(indexedSegments),
    ...(subtitleStatus === "pending" ? { subtitleStatus } : {}),
    alignment: normalizeWorkflowAudioAlignment(normalizedParts.find((part) => part.alignment)?.alignment),
    parts: normalizedParts,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function upsertWorkflowAudioTrack(tracks = [], track, options = {}) {
  const normalizedTrack = normalizeWorkflowAudioTrack(track);
  if (!normalizedTrack) return Array.isArray(tracks) ? tracks : [];
  const currentTracks = (Array.isArray(tracks) ? tracks : []).map(normalizeWorkflowAudioTrack).filter(Boolean);
  const replaceVariant = options.replaceVariant || "";
  const nextTracks = currentTracks.filter((item) => {
    if (normalizedTrack.id && item.id === normalizedTrack.id) return false;
    if (replaceVariant && item.variant === replaceVariant && item.source !== "upload") return false;
    return true;
  });
  return [...nextTracks, normalizedTrack];
}

function workflowAudioTrackLabel(variant = "voice") {
  if (variant === "upload") return "上传音频";
  if (workflowCopyLanguageLabels[variant]) return `${workflowCopyLanguageLabel(variant)}音频`;
  return "口播音频";
}

function workflowAudioUrl(track = {}) {
  return stringFromWorkflowValue(track?.audio_url || track?.audioUrl || track?.url || track?.fileUrl).trim();
}

function workflowAudioVariantHasGeneratedTrack(summary = {}, variant = "") {
  return firstWorkflowArray(summary.audioTracks)
    .some((track) => track.variant === variant && track.source !== "upload" && workflowAudioUrl(track));
}

function workflowAudioHasAnyGeneratedTrack(summary = {}) {
  return Boolean(
    summary.audioUrl ||
      firstWorkflowArray(summary.audioTracks).some((track) => track.source !== "upload" && workflowAudioUrl(track)),
  );
}

function workflowAudioScriptChoices(summary = {}, workflow = {}) {
  const sourceLanguage = workflowConfiguredLanguage(workflow);
  const sourceScript = stringFromWorkflowValue(summary.script).trim();
  return [
    {
      variant: sourceLanguage,
      label: `生成${workflowCopyLanguageLabel(sourceLanguage)}音频`,
      script: sourceScript,
      count: countWorkflowChars(sourceScript),
      available: Boolean(sourceScript),
      emptyText: `暂无${workflowCopyLanguageLabel(sourceLanguage)}文案`,
    },
  ];
}

function workflowDraftAudioChoices(summary = {}, musicAssets = []) {
  const tracks = (Array.isArray(summary.audioTracks) ? summary.audioTracks : [])
    .map((track) => ({
      id: String(track.id || ""),
      label: stringFromWorkflowValue(track.label) || workflowAudioTrackLabel(track.variant),
      source: String(track.source || "generated"),
      duration: Number(track.duration || 0),
      segments: firstWorkflowArray(track.segments),
      audioUrl: resolveFlowStudioFileUrl(track.audio_url || track.audioUrl || track.url || ""),
    }))
    .filter((track) => track.id || track.audioUrl || track.segments.length);
  const choices = tracks.map((track, index) => {
    const sourceLabel = track.source === "upload" ? "上传音频" : "生成音频";
    return {
      id: track.id || `audio-track-${index + 1}`,
      label: track.label || `音频 ${index + 1}`,
      meta: `${sourceLabel} · ${track.segments.length} 条字幕 · ${formatWorkflowDuration(track.duration)}`,
      source: track.source,
      audioUrl: track.audioUrl,
      duration: track.duration,
      timingTrackId: track.id || `audio-track-${index + 1}`,
      disabled: !track.audioUrl || !track.segments.length,
    };
  });
  if (!choices.length && (summary.audioUrl || summary.audioSegments.length)) {
    choices.push({
      id: "legacy-audio",
      label: "口播音频",
      meta: `${summary.audioSegments.length} 条字幕 · ${formatWorkflowDuration(summary.audioDuration)}`,
      source: "generated",
      audioUrl: resolveFlowStudioFileUrl(summary.audioUrl || ""),
      duration: Number(summary.audioDuration || 0),
      timingTrackId: "legacy-audio",
      disabled: !summary.audioUrl || !summary.audioSegments.length,
    });
  }
  const timingChoice = choices.find((choice) => !choice.disabled) || null;
  const musicChoices = (Array.isArray(musicAssets) ? musicAssets : []).map((asset) => ({
    id: `music:${asset.id}`,
    sourceId: asset.id,
    label: `音乐库 · ${asset.name}`,
    meta: timingChoice ? "沿用最终 SRT 时间轴" : "缺少最终 SRT",
    source: "music",
    audioUrl: resolveFlowStudioFileUrl(asset.fileUrl || ""),
    duration: Number(asset.duration || 0),
    timingTrackId: timingChoice?.timingTrackId || "",
    disabled: !asset.fileUrl || !timingChoice,
  }));
  return [...choices, ...musicChoices];
}

function workflowDraftPreviewImageUrl(summary = {}) {
  const imageShots = Array.isArray(summary.imageShots) ? summary.imageShots : [];
  const shots = Array.isArray(summary.shots) ? summary.shots : [];
  return [...imageShots, ...shots].map(workflowShotImageUrl).find(Boolean) || "";
}

function workflowDraftMaterialChoices(summary = {}) {
  const imageCount = Array.isArray(summary.imageShots) && summary.imageShots.length
    ? summary.imageShots.length
    : (Array.isArray(summary.shots) ? summary.shots.filter((shot) => workflowShotImageUrl(shot)).length : 0);
  const videoResults = Array.isArray(summary.videoResults) ? summary.videoResults : [];
  const videoTimeline = Array.isArray(summary.videoTimeline) ? summary.videoTimeline : [];
  const readyVideoCount = videoTimeline.length
    ? videoTimeline.filter((item, index) => videoResults.some((video) => (
        workflowVideoResultMatchesTarget(video, workflowVideoTargetFromTimelineItem(item, index))
        && workflowVideoUrl(video)
      ))).length
    : videoResults.filter((video) => workflowVideoUrl(video)).length;
  const expectedVideoCount = videoTimeline.length || readyVideoCount;
  return [
    {
      id: "image",
      label: "图片素材",
      meta: `${imageCount} 张图片`,
      disabled: imageCount <= 0,
    },
    {
      id: "video",
      label: "视频素材",
      meta: expectedVideoCount ? `${readyVideoCount}/${expectedVideoCount} 个视频已就绪` : "暂无视频",
      disabled: expectedVideoCount <= 0 || readyVideoCount < expectedVideoCount,
    },
  ];
}

function workflowDraftRatioChoices() {
  return [
    {
      id: "16:9",
      label: "16:9 横屏",
      meta: "1920 x 1080",
    },
    {
      id: "9:16",
      label: "9:16 竖屏",
      meta: "1080 x 1920",
    },
    {
      id: "1:1",
      label: "1:1 方屏",
      meta: "1080 x 1080",
    },
  ];
}

function workflowDraftImageMotionChoices() {
  return [
    { id: "none", label: "关闭" },
    { id: "zoom_in", label: "缓慢放大" },
  ];
}

function workflowDraftImageMotionScaleChoices() {
  return [
    { id: "1.03", label: "1.03" },
    { id: "1.06", label: "1.06" },
    { id: "1.10", label: "1.10" },
  ];
}

function friendlyWorkflowAudioUploadError(error) {
  const message = error?.message || "音频上传或解析失败。";
  const upstreamStatus = Number(error?.payload?.detail?.upstreamStatus || 0);
  const provider = String(error?.payload?.detail?.provider || "");
  if (upstreamStatus === 404) return "转写服务接口不存在，请联系站点管理员检查适配器配置。";
  if ((error?.status === 404 && /接口不存在/i.test(message)) || /接口不存在/i.test(message)) {
    return "上传音频解析接口不存在。请确认 Railway 后端已部署包含 音频服务 ASR 的最新代码，并且前端 NEXT_PUBLIC_API_BASE_URL 指向这次更新后的后端服务。";
  }
  return message;
}

function buildWorkflowAudioFromManualInput(input = {}, script = "") {
  const segments = estimateWorkflowAudioSegments(script, Number(input.duration || 0));
  return {
    audio_url: String(input.audioUrl || "").trim(),
    duration: Number(input.duration || 0) || Number(segments.at(-1)?.end || 0),
    segments,
    subtitle_srt: workflowSegmentsToSrt(segments),
    source: "manual",
  };
}

function buildWorkflowAudioFromGeneratedResult(result = {}, script = "") {
  const audioUrl = resolveFlowStudioFileUrl(result.audioUrl || result.audio_url || result.url || result.fileUrl || "");
  const rawSegments = firstWorkflowArray(result.segments, result.timestamps, result.data?.segments, result.result?.segments);
  const duration = Number(result.duration || result.audioDuration || result.data?.duration || result.result?.duration || 0);
  const sentenceCount = splitWorkflowSentences(script).length;
  const shouldEstimateSegments = !rawSegments.length || (sentenceCount > rawSegments.length && rawSegments.length <= 1);
  const segments = shouldEstimateSegments ? estimateWorkflowAudioSegments(script, duration) : normalizeWorkflowAudioSegments(rawSegments, script, duration);
  return {
    audio_url: audioUrl,
    duration: duration > 0 ? duration : Number(segments.at(-1)?.end || 0),
    segments,
    subtitle_srt: stringFromWorkflowValue(result.subtitleSrt || result.subtitle_srt || result.srt || result.data?.subtitle_srt || result.result?.subtitle_srt) || workflowSegmentsToSrt(segments),
    source: "generated",
    provider: result.provider || "",
    model: result.model || result.modelId || "",
  };
}

function buildWorkflowAudioFromTranscription(input = {}, result = {}, fallbackScript = "") {
  const audioUrl = String(input.audioUrl || "").trim();
  const rawSegments = firstWorkflowArray(result.tokens, result.timedTokens, result.words, result.rawSegments, result.segments, result.timestamps, result.data?.tokens, result.data?.segments, result.result?.tokens, result.result?.segments);
  const asrText = stringFromWorkflowValue(result.text || result.transcript || result.content || result.data?.text || result.result?.text);
  const preserveRawTiming = Boolean(input.preserveRawTiming);
  const referenceSegments = normalizeWorkflowReferenceSegments(input.referenceSegments, preserveRawTiming ? "" : fallbackScript);
  const rawTimedSegments = normalizeWorkflowAsrTokens(rawSegments).map((token, index) => ({
    index: index + 1,
    text: token.text,
    start: token.start,
    end: token.end,
  }));
  const text = referenceSegments.length ? referenceSegments.map((segment) => segment.text).join("") : stringFromWorkflowValue(asrText || fallbackScript);
  const duration = Number(result.duration || result.audioDuration || result.data?.duration || result.result?.duration || 0);
  const referenceFallbackSegments = referenceSegments.length ? estimateWorkflowReferenceSegments(referenceSegments, duration) : [];
  const aligned = referenceSegments.length && rawSegments.length
    ? alignWorkflowReferenceSegmentsToAsrTokens(referenceSegments, rawSegments, duration)
    : null;
  const alignedSegments = aligned
    ? aligned.segments
    : referenceFallbackSegments.length
      ? referenceFallbackSegments
      : rawSegments.length
      ? normalizeWorkflowAudioSegments(rawSegments, text, duration)
      : estimateWorkflowAudioSegments(text, duration);
  const segments = preserveRawTiming ? [] : alignedSegments;
  const finalRawSegments = rawTimedSegments.length ? rawTimedSegments : alignedSegments;
  const fallbackAlignment = referenceSegments.length && rawSegments.length ? null : workflowAudioAlignmentMeta({
    confidence: referenceSegments.length ? 0 : 1,
    matchedChars: 0,
    totalChars: normalizeWorkflowAudioMatchText(text).length,
    fallbackCount: segments.length,
  });
  return {
    audio_url: audioUrl,
    duration: duration > 0 ? duration : Number(finalRawSegments.at(-1)?.end || segments.at(-1)?.end || 0),
    ...(preserveRawTiming ? { rawSegments: finalRawSegments } : {}),
    segments,
    subtitle_srt: preserveRawTiming ? "" : workflowSegmentsToSrt(segments),
    ...(preserveRawTiming ? { subtitleStatus: "pending" } : {}),
    source: input.source || "upload-asr",
    provider: input.provider || result.provider || "音频服务",
    model: input.model || result.model || "",
    asr_text: asrText,
    alignment: normalizeWorkflowAudioAlignment(aligned?.alignment || fallbackAlignment),
    text,
  };
}

function readWorkflowAudioFileDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("音频文件读取失败，请重新选择文件。"));
    reader.readAsDataURL(file);
  });
}

function workflowTimelineFromAudio(run, audio) {
  const shots = Array.isArray(run?.shots) ? run.shots : [];
  return {
    audio: {
      url: audio.audio_url,
      duration: audio.duration,
    },
    ...(Array.isArray(audio.rawSegments) && audio.rawSegments.length ? {
      raw_segments: audio.rawSegments.map((segment, index) => ({
        index: Number(segment.index || index + 1),
        text: segment.text,
        start: segment.start,
        end: segment.end,
      })),
    } : {}),
    segments: (audio.segments || []).map((segment, index) => {
      const shot = shots[index] || {};
      return {
        index: segment.index,
        text: segment.text,
        start: segment.start,
        end: segment.end,
        image_url: workflowShotImageUrl(shot),
        video_url: "",
      };
    }),
    subtitle_srt: audio.subtitle_srt,
  };
}

function workflowAudioReferenceSegmentsForScript(run = {}, script = "") {
  const shotChunks = workflowAudioShotTextsForScript(run, script);
  if (shotChunks.length) {
    return shotChunks.map((chunk, index) => ({
      index: index + 1,
      text: chunk.text,
      source: "shot",
    }));
  }
  return splitWorkflowSentences(script).map((text, index) => ({
    index: index + 1,
    text,
    source: "script",
  }));
}

function workflowAudioReferenceSegmentsForChunk(run = {}, script = "", chunkText = "") {
  const shotChunks = workflowAudioShotTextsForScript(run, script);
  if (!shotChunks.length) return workflowAudioReferenceSegmentsForText(chunkText);
  const chunkNorm = normalizeWorkflowAudioMatchText(chunkText);
  const selected = shotChunks.filter((chunk) => {
    const shotNorm = normalizeWorkflowAudioMatchText(chunk.text);
    if (!shotNorm) return false;
    return chunkNorm.includes(shotNorm) || shotNorm.includes(chunkNorm);
  });
  const chunks = selected.length ? selected : (shotChunks.length === 1 ? shotChunks : []);
  if (!chunks.length) return workflowAudioReferenceSegmentsForText(chunkText);
  return chunks.map((chunk, index) => ({
    index: index + 1,
    text: chunk.text,
    source: "shot",
  }));
}

function workflowAudioReferenceSegmentsForText(script = "") {
  return splitWorkflowSentences(script).map((text, index) => ({
    index: index + 1,
    text,
    source: "script",
  }));
}

function workflowAudioLanguageForVariant(variant = "", workflow = {}) {
  if (variant === "zh") return "zh";
  if (variant === "en") return "en";
  const language = stringFromWorkflowValue(workflow?.workflow?.language || workflow?.language).trim().toLowerCase();
  if (/^en/.test(language)) return "en";
  if (/^zh|cn|chinese/.test(language)) return "zh";
  return language || "";
}

function normalizeWorkflowReferenceSegments(referenceSegments = [], fallbackScript = "") {
  const segments = firstWorkflowArray(referenceSegments)
    .map((segment, index) => ({
      index: Number(segment.index || index + 1),
      text: stringFromWorkflowValue(segment.text || segment.script || segment.content || segment).trim(),
    }))
    .filter((segment) => segment.text);
  if (segments.length) return segments;
  return splitWorkflowSentences(fallbackScript).map((text, index) => ({
    index: index + 1,
    text,
  }));
}

function alignWorkflowReferenceSegmentsToAsrTokens(referenceSegments = [], rawTokens = [], duration = 0) {
  const tokens = normalizeWorkflowAsrTokens(rawTokens);
  if (!tokens.length) {
    const text = referenceSegments.map((segment) => segment.text).join("");
    return {
      segments: estimateWorkflowReferenceSegments(referenceSegments, duration),
      alignment: workflowAudioAlignmentMeta({
        confidence: 0,
        matchedChars: 0,
        totalChars: normalizeWorkflowAudioMatchText(text).length,
        fallbackCount: referenceSegments.length,
      }),
    };
  }
  const asrText = tokens.map((token) => token.norm).join("");
  const referenceText = referenceSegments.map((segment) => normalizeWorkflowAudioMatchText(segment.text)).join("");
  const scale = referenceText.length > 0 && asrText.length > 0 ? asrText.length / referenceText.length : 1;
  let referenceCursor = 0;
  let asrCursor = 0;
  let matchedChars = 0;
  let fallbackCount = 0;
  const segments = referenceSegments.map((segment, index) => {
    const norm = normalizeWorkflowAudioMatchText(segment.text);
    const fallbackStart = Math.round(referenceCursor * scale);
    const fallbackEnd = Math.round((referenceCursor + Math.max(1, norm.length)) * scale);
    const searchFrom = Math.max(0, asrCursor - 24);
    const matchedStart = norm ? asrText.indexOf(norm, searchFrom) : -1;
    if (matchedStart >= 0) matchedChars += norm.length;
    else fallbackCount += 1;
    const startOffset = matchedStart >= 0 ? matchedStart : fallbackStart;
    const endOffset = matchedStart >= 0 ? matchedStart + norm.length : fallbackEnd;
    const timing = workflowTokenTimingForOffsets(tokens, startOffset, endOffset, duration);
    referenceCursor += norm.length;
    asrCursor = Math.max(asrCursor, endOffset);
    return {
      index: index + 1,
      text: segment.text,
      start: roundWorkflowTime(timing.start),
      end: roundWorkflowTime(timing.end),
    };
  }).filter((segment) => segment.text && segment.end >= segment.start);
  return {
    segments,
    alignment: workflowAudioAlignmentMeta({
      confidence: referenceText.length ? matchedChars / referenceText.length : 1,
      matchedChars,
      totalChars: referenceText.length,
      fallbackCount,
    }),
  };
}

function estimateWorkflowReferenceSegments(referenceSegments = [], requestedDuration = 0) {
  const refs = firstWorkflowArray(referenceSegments)
    .map((segment, index) => ({
      index: Number(segment.index || index + 1),
      text: stringFromWorkflowValue(segment.text || segment.script || segment.content || segment).trim(),
    }))
    .filter((segment) => segment.text);
  const durations = refs.map((segment) => estimateWorkflowSentenceDuration(segment.text));
  const rawDuration = durations.reduce((sum, value) => sum + value, 0);
  const scale = requestedDuration > 0 && rawDuration > 0 ? requestedDuration / rawDuration : 1;
  let cursor = 0;
  return refs.map((segment, index) => {
    const start = roundWorkflowTime(cursor);
    const end = roundWorkflowTime(cursor + durations[index] * scale);
    cursor = end;
    return {
      index: index + 1,
      text: segment.text,
      start,
      end,
    };
  });
}

function workflowAudioAlignmentMeta(meta = {}) {
  const confidence = Math.max(0, Math.min(1, Number(meta.confidence || 0)));
  const matchedChars = Math.max(0, Number(meta.matchedChars || 0));
  const totalChars = Math.max(0, Number(meta.totalChars || 0));
  const fallbackCount = Math.max(0, Number(meta.fallbackCount || 0));
  const lowConfidence = totalChars > 0 && confidence < 0.45;
  return {
    confidence: roundWorkflowTime(confidence),
    matchedChars,
    totalChars,
    fallbackCount,
    lowConfidence,
    warning: lowConfidence ? "音频和工作流文案不完全匹配，字幕时间可能有偏差。" : "",
  };
}

function normalizeWorkflowAudioAlignment(alignment = {}) {
  if (!alignment || typeof alignment !== "object") return null;
  const normalized = workflowAudioAlignmentMeta(alignment);
  return normalized.totalChars || normalized.matchedChars || normalized.fallbackCount ? normalized : null;
}

function workflowAudioAlignmentWarning(track = {}) {
  const alignment = normalizeWorkflowAudioAlignment(track.alignment || firstWorkflowArray(track.parts).find((part) => part.alignment)?.alignment);
  return alignment?.lowConfidence ? alignment.warning : "";
}

function workflowAudioExpectedSubtitleCount(run = {}, summary = {}) {
  const shots = Array.isArray(summary?.shots) && summary.shots.length
    ? summary.shots
    : Array.isArray(run?.shots) && run.shots.length
      ? run.shots
      : workflowParsedShotOutput(run);
  if (!shots.length) return 0;
  const imageCount = shots.filter((shot) => workflowShotImageUrl(shot)).length;
  return imageCount || shots.length;
}

function workflowAudioTrackSubtitleCountWarning(track = {}, run = {}, summary = {}) {
  const expected = workflowAudioExpectedSubtitleCount(run, summary);
  const actual = Array.isArray(track.segments) ? track.segments.length : 0;
  if (!expected || !actual || expected === actual) return "";
  return `当前 SRT 是 ${actual} 条，但分镜图片是 ${expected} 张。生成剪辑草稿前，建议编辑 SRT 或重新生成音频，让字幕数量和图片数量一致。`;
}

function normalizeWorkflowAsrTokens(rawTokens = []) {
  let cursor = 0;
  return firstWorkflowArray(rawTokens)
    .map((token, index) => {
      const text = stringFromWorkflowValue(token.text || token.word || token.sentence || token.content || token).trim();
      const norm = normalizeWorkflowAudioMatchText(text);
      if (!norm) return null;
      const start = Number.isFinite(Number(token.start)) ? Number(token.start) : Number(token.start_time || token.begin || cursor);
      const rawEnd = Number.isFinite(Number(token.end)) ? Number(token.end) : Number(token.end_time || token.finish || 0);
      const end = Math.max(start, rawEnd || start + estimateWorkflowSentenceDuration(text));
      const normStart = cursor;
      const normEnd = normStart + norm.length;
      cursor = normEnd;
      return {
        index: Number(token.index || token.id || index + 1),
        text,
        norm,
        normStart,
        normEnd,
        start: roundWorkflowTime(start),
        end: roundWorkflowTime(end),
      };
    })
    .filter(Boolean);
}

function workflowTokenTimingForOffsets(tokens = [], startOffset = 0, endOffset = 0, duration = 0) {
  const selected = tokens.filter((token) => token.normEnd > startOffset && token.normStart < endOffset);
  if (selected.length) {
    return {
      start: selected[0].start,
      end: selected[selected.length - 1].end,
    };
  }
  const totalChars = Math.max(1, tokens.at(-1)?.normEnd || 0);
  const totalDuration = Number(duration || tokens.at(-1)?.end || 0);
  const start = totalDuration * Math.max(0, startOffset) / totalChars;
  const end = totalDuration * Math.max(startOffset + 1, endOffset) / totalChars;
  return { start, end };
}

function normalizeWorkflowAudioSegments(segments = [], script = "", totalDuration = 0) {
  const fallbackTexts = splitWorkflowSentences(script);
  let cursor = 0;
  return segments.map((segment, index) => {
    const text = stringFromWorkflowValue(segment.text || segment.sentence || fallbackTexts[index] || "").trim();
    if (!text) return null;
    const start = Number.isFinite(Number(segment.start)) ? Number(segment.start) : cursor;
    const fallbackEnd = index === segments.length - 1 && totalDuration > 0 ? totalDuration : start + estimateWorkflowSentenceDuration(text);
    const end = Math.max(start, Number.isFinite(Number(segment.end)) ? Number(segment.end) : fallbackEnd);
    cursor = end;
    return {
      index: Number(segment.index || index + 1),
      text,
      start: roundWorkflowTime(start),
      end: roundWorkflowTime(end),
    };
  }).filter(Boolean);
}

function estimateWorkflowAudioSegments(script = "", requestedDuration = 0) {
  const sentences = splitWorkflowSentences(script);
  const durations = sentences.map(estimateWorkflowSentenceDuration);
  const rawDuration = durations.reduce((sum, value) => sum + value, 0);
  const scale = requestedDuration > 0 && rawDuration > 0 ? requestedDuration / rawDuration : 1;
  let cursor = 0;
  return sentences.map((text, index) => {
    const start = roundWorkflowTime(cursor);
    const end = roundWorkflowTime(cursor + durations[index] * scale);
    cursor = end;
    return {
      index: index + 1,
      text,
      start,
      end,
    };
  });
}

function alignWorkflowAudioTrackToShots(run = {}, track = {}, script = "") {
  const normalizedTrack = normalizeWorkflowAudioTrack(track);
  if (!normalizedTrack) return track;
  const shotSegments = workflowAudioShotSegmentsForScript(run, script, normalizedTrack.duration);
  if (!shotSegments.length) return normalizedTrack;
  return {
    ...normalizedTrack,
    segments: shotSegments,
    subtitle_srt: workflowSegmentsToSrt(shotSegments),
  };
}

function workflowAudioShotSegmentsForScript(run = {}, script = "", duration = 0) {
  const chunks = workflowAudioShotTextsForScript(run, script);
  if (!chunks.length) return [];
  const rawDurations = chunks.map((chunk) => estimateWorkflowSentenceDuration(chunk.text));
  const rawDuration = rawDurations.reduce((sum, value) => sum + value, 0);
  const totalDuration = Number(duration || 0) > 0 ? Number(duration) : rawDuration;
  const scale = rawDuration > 0 && totalDuration > 0 ? totalDuration / rawDuration : 1;
  let cursor = 0;
  return chunks.map((chunk, index) => {
    const start = roundWorkflowTime(cursor);
    const end = roundWorkflowTime(cursor + rawDurations[index] * scale);
    cursor = end;
    return {
      index: index + 1,
      text: chunk.text,
      start,
      end,
    };
  });
}

function workflowAudioShotTextsForScript(run = {}, script = "") {
  const finalText = stringFromWorkflowValue(script).trim();
  const shots = workflowShotsWithParsedScripts(run);
  if (!finalText || !shots.length) return [];
  const target = normalizeWorkflowAudioMatchText(finalText);
  const candidates = ["display", "zh", "en"]
    .map((language) => workflowAudioShotTextCandidate(shots, language, target))
    .filter((candidate) => candidate.chunks.length);
  if (!candidates.length) return [];
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].score > 0 ? candidates[0].chunks : [];
}

function workflowShotsWithParsedScripts(run = {}) {
  const storedShots = Array.isArray(run?.shots) ? run.shots : [];
  const parsedShots = workflowParsedShotOutput(run);
  if (!storedShots.length) return parsedShots;
  if (!parsedShots.length) return storedShots;
  const parsedByIndex = new Map(parsedShots.map((shot, index) => [Number(shot.index || index + 1), shot]));
  return storedShots.map((shot, index) => {
    if (workflowShotScriptText(shot)) return shot;
    const parsed = parsedByIndex.get(Number(shot.index || index + 1)) || parsedShots[index] || {};
    const parsedScript = workflowShotScriptText(parsed);
    if (!parsedScript) return shot;
    return {
      ...shot,
      script: parsedScript,
      prompt: stringFromWorkflowValue(shot.prompt || shot.imagePrompt || shot.description) || stringFromWorkflowValue(parsed.prompt),
    };
  });
}

function workflowAudioShotTextCandidate(shots = [], language = "display", target = "") {
  const chunks = shots
    .map((shot, index) => {
      const text = (language === "display" ? workflowShotScriptText(shot) : workflowShotScriptTextForLanguage(shot, language)).trim();
      if (!text) return null;
      const number = workflowShotNumber(shot, index);
      return {
        text,
        name: `镜头 ${number}`,
      };
    })
    .filter(Boolean);
  if (!chunks.length || !target) return { language, chunks, score: 0 };
  const combined = normalizeWorkflowAudioMatchText(chunks.map((chunk) => chunk.text).join(""));
  const sample = chunks.map((chunk) => normalizeWorkflowAudioMatchText(chunk.text)).find((text) => text.length >= 6) || combined.slice(0, 24);
  const targetHead = target.slice(0, Math.min(40, target.length));
  let score = 0;
  if (sample && target.includes(sample)) score += sample.length;
  if (targetHead && combined.includes(targetHead)) score += targetHead.length;
  score += workflowTextOverlapScore(combined, target);
  return { language, chunks, score };
}

function workflowTextOverlapScore(left = "", right = "") {
  if (!left || !right) return 0;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length > right.length ? left : right;
  const step = Math.max(4, Math.floor(shorter.length / 20));
  let score = 0;
  for (let index = 0; index < shorter.length; index += step) {
    const piece = shorter.slice(index, index + step);
    if (piece.length >= 4 && longer.includes(piece)) score += piece.length;
  }
  return score;
}

function normalizeWorkflowAudioMatchText(text = "") {
  return stringFromWorkflowValue(text).replace(/[\s。！？!?；;，,：:、.]/g, "").trim().toLowerCase();
}

function workflowAudioChunkLimit() {
  return workflowAudioRequestMaxChars;
}

function splitWorkflowAudioText(text = "", maxChars = workflowAudioRequestMaxChars, options = {}) {
  const source = stringFromWorkflowValue(text).trim();
  if (!source) return [];
  const referenceSegments = firstWorkflowArray(options.referenceSegments)
    .map((segment, index) => ({
      index: Number(segment.index || index + 1),
      name: stringFromWorkflowValue(segment.name || `镜头 ${Number(segment.index || index + 1)}`),
      text: stringFromWorkflowValue(segment.text || segment.script || segment.content || segment).trim(),
    }))
    .filter((segment) => segment.text);
  if (referenceSegments.length) return splitWorkflowAudioReferenceSegments(referenceSegments, maxChars);
  const units = splitWorkflowSentences(source);
  const pieces = units.length ? units : [source];
  const chunks = [];
  let current = "";

  const pushCurrent = () => {
    const value = current.trim();
    if (value) chunks.push({ text: value });
    current = "";
  };

  pieces.forEach((piece) => {
    if (piece.length > maxChars) {
      pushCurrent();
      for (let index = 0; index < piece.length; index += maxChars) {
        const chunk = piece.slice(index, index + maxChars).trim();
        if (chunk) chunks.push({ text: chunk });
      }
      return;
    }
    const next = current ? `${current}\n${piece}` : piece;
    if (next.length <= maxChars) {
      current = next;
      return;
    }
    pushCurrent();
    current = piece;
  });
  pushCurrent();
  return chunks.length ? chunks : [{ text: source }];
}

function splitWorkflowAudioReferenceSegments(referenceSegments = [], maxChars = workflowAudioRequestMaxChars) {
  const chunks = [];
  let current = [];
  const limit = Math.max(120, Number(maxChars || workflowAudioRequestMaxChars));

  const pushCurrent = () => {
    if (!current.length) return;
    const first = current[0];
    const last = current[current.length - 1];
    chunks.push({
      text: current.map((segment) => segment.text).join("\n"),
      name: first.name === last.name ? first.name : `${first.name}-${last.name}`,
      referenceSegments: current.map((segment, index) => ({
        index: index + 1,
        text: segment.text,
        name: segment.name,
      })),
    });
    current = [];
  };

  referenceSegments.forEach((segment) => {
    const nextText = [...current, segment].map((item) => item.text).join("\n");
    if (current.length && nextText.length > limit) pushCurrent();
    current.push(segment);
  });
  pushCurrent();
  return chunks.length ? chunks : [{ text: referenceSegments.map((segment) => segment.text).join("\n") }];
}

function splitWorkflowSentences(script = "") {
  const matches = String(script || "").replace(/\r\n/g, "\n").trim().match(/[^。！？!?；;，,：:、.\n]+[。！？!?；;，,：:、.]?/g) || [];
  return matches.map((item) => item.trim()).filter(Boolean);
}

function estimateWorkflowSentenceDuration(text = "") {
  const value = String(text || "").trim();
  const latinWords = value.match(/[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?/g) || [];
  if (latinWords.length >= Math.max(3, value.length / 5)) return Math.max(1.2, latinWords.length / 2.45 + 0.25);
  return Math.max(1.2, value.replace(/\s+/g, "").length / 4.2 + 0.2);
}

function workflowSegmentsToSrt(segments = []) {
  return segments.map((segment, index) => (
    `${index + 1}\n${workflowSrtTime(segment.start)} --> ${workflowSrtTime(segment.end)}\n${segment.text}\n`
  )).join("\n");
}

function parseWorkflowSrtSegments(srt = "") {
  return String(srt || "")
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((block, index) => parseWorkflowSrtBlock(block, index))
    .filter(Boolean)
    .map((segment, index) => ({ ...segment, index: index + 1 }));
}

function parseWorkflowSrtBlock(block = "", fallbackIndex = 0) {
  const lines = String(block || "").split("\n").map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return null;
  const timeLineIndex = lines.findIndex((line) => /-->/i.test(line));
  if (timeLineIndex < 0) return null;
  const timeMatch = lines[timeLineIndex].match(/(.+?)\s*-->\s*(.+)/);
  if (!timeMatch) return null;
  const start = parseWorkflowSrtTime(timeMatch[1]);
  const end = parseWorkflowSrtTime(timeMatch[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const text = lines.slice(timeLineIndex + 1).join("\n").trim();
  if (!text) return null;
  return {
    index: fallbackIndex + 1,
    text,
    start: roundWorkflowTime(start),
    end: roundWorkflowTime(end),
  };
}

function parseWorkflowSrtTime(value = "") {
  const match = String(value || "").trim().match(/(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2})(?:[,.](\d{1,3}))?/);
  if (!match) return NaN;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  const ms = Number(String(match[4] || "0").padEnd(3, "0").slice(0, 3));
  return hours * 3600 + minutes * 60 + seconds + ms / 1000;
}

function workflowSrtTime(seconds) {
  const totalMs = Math.max(0, Math.round(Number(seconds || 0) * 1000));
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const sec = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const min = totalMinutes % 60;
  const hour = Math.floor(totalMinutes / 60);
  return `${String(hour).padStart(2, "0")}:${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function formatWorkflowDuration(seconds) {
  const total = Math.max(0, Number(seconds || 0));
  const min = Math.floor(total / 60);
  const sec = Math.floor(total % 60);
  const ms = Math.round((total - Math.floor(total)) * 10);
  return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}${ms ? `.${ms}` : ""}`;
}

function formatWorkflowTimelineRange(start, end) {
  return `${formatWorkflowDuration(start)} → ${formatWorkflowDuration(end)}`;
}

function formatWorkflowSegmentTime(seconds) {
  return formatWorkflowDuration(seconds);
}

function roundWorkflowTime(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function workflowVideoTitle(video, index) {
  if (!video || typeof video === "string") return `视频 ${index + 1}`;
  return video.title || video.name || video.fileName || video.prompt || `视频 ${index + 1}`;
}

function workflowVideoDescription(video) {
  if (!video || typeof video === "string") return "";
  return stringFromWorkflowValue(video.description || video.summary || video.error || video.message || video.status);
}

function countWorkflowChars(text = "") {
  return String(text).replace(/\s/g, "").length;
}

async function copyWorkflowText(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
}

function safeWorkflowFileName(name) {
  return `${String(name || "video").replace(/[\\/:*?"<>|]+/g, "-").trim() || "video"}.mp4`;
}

function safeWorkflowImageFileName(name) {
  return String(name || "workflow-image")
    .replace(/[^\w.-]+/g, "-")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "workflow-image";
}

function safeWorkflowZipName(name) {
  return String(name || "workflow-images")
    .replace(/[^\w.-]+/g, "-")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "workflow-images";
}

function workflowDownloadTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function workflowImageZipBaseName(run, date = new Date()) {
  return safeWorkflowZipName(`task-${workflowRunShortId(run)}-${workflowDownloadTimestamp(date)}`);
}

function workflowVideoZipBaseName(run, date = new Date()) {
  return safeWorkflowZipName(`task-${workflowRunShortId(run)}-video-materials-${workflowDownloadTimestamp(date)}`);
}

function workflowPackageExpiresText(expiresAt) {
  if (!expiresAt) return "24 小时内有效";
  const remainingMs = workflowPackageExpiresMs(expiresAt) - Date.now();
  if (remainingMs <= 0) return "已过期";
  const hours = Math.max(1, Math.ceil(remainingMs / (60 * 60 * 1000)));
  return hours >= 24 ? "24 小时内有效" : `${hours} 小时内有效`;
}

function workflowPackageExpiresMs(expiresAt) {
  if (!expiresAt) return 0;
  const numeric = Number(expiresAt);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function workflowPackageIsExpired(expiresAt) {
  const expiresMs = workflowPackageExpiresMs(expiresAt);
  return Boolean(expiresMs && Date.now() > expiresMs);
}

function workflowResetVideoPackageResult() {
  return {
    videoPackage: {},
    videoPackageStatus: "",
    videoPackageName: "",
    videoPackageDetail: "",
    videoPackageError: "",
    videoPackageProgress: 0,
    videoPackageDone: 0,
    videoPackageTotal: 0,
    ...workflowResetVideoResultPackageResult(),
  };
}

function workflowResetVideoResultPackageResult() {
  return {
    videoResultPackage: {},
    videoResultPackageStatus: "",
    videoResultPackageTaskId: "",
    videoResultPackageName: "",
    videoResultPackageDetail: "",
    videoResultPackageError: "",
    videoResultPackageProgress: 0,
    videoResultPackageDone: 0,
    videoResultPackageTotal: 0,
    videoResultPackageDownloadPath: "",
    videoResultPackageExpiresAt: 0,
  };
}

function workflowVideoGroupCount(total, groupSize) {
  return Math.ceil((Number(total) || 0) / Math.max(1, Number(groupSize) || 1));
}

function workflowVideoTimelineGroups(shots, groupSize) {
  const size = Math.max(1, Math.min(5, Number(groupSize) || 1));
  const sortedShots = [...(Array.isArray(shots) ? shots : [])]
    .filter((shot) => workflowShotImageUrl(shot))
    .sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0));
  const groups = [];
  for (let start = 0; start < sortedShots.length; start += size) {
    const groupShots = sortedShots.slice(start, start + size);
    const first = groupShots[0];
    const last = groupShots[groupShots.length - 1];
    const assets = groupShots.map((shot, index) => ({
      shotId: workflowShotId(shot),
      index: Number(shot.index) || start + index + 1,
      imageUrl: workflowShotImageUrl(shot),
      imageThumbnailUrl: workflowShotThumbnailUrl(shot),
      imagePrompt: stringFromWorkflowValue(shot.imagePrompt || shot.prompt || shot.description),
    }));
    groups.push({
      id: createWorkflowLocalId(),
      shotId: workflowShotId(first),
      shotIds: groupShots.map(workflowShotId).filter(Boolean),
      index: groups.length + 1,
      startIndex: Number(first.index) || start + 1,
      endIndex: Number(last.index) || start + groupShots.length,
      groupSize: assets.length,
      imageUrl: workflowShotImageUrl(first),
      imageThumbnailUrl: workflowShotThumbnailUrl(first),
      imagePrompt: assets.map((asset) => asset.imagePrompt).filter(Boolean).join("\n\n"),
      assets,
      videoPrompt: "",
    });
  }
  return groups;
}

function workflowEcommerceVideoTimeline(run = {}, summary = {}, groupSize = 1, shotDurationSeconds = 5) {
  const storyboard = ecommerceStoryboardShots(summary.script || summary.shotOutput || run.shotOutput || "");
  const rawImageAssets = Array.isArray(run.shots) ? run.shots : Array.isArray(summary.shots) ? summary.shots : [];
  const imageAssets = attachEcommerceShotAssetRefs(rawImageAssets, workflowShotAssetRefsMap(summary.shotAssetRefs) || workflowShotAssetRefsMap(run.shotAssetRefs) || new Map());
  const size = Math.max(1, Math.min(5, Number(groupSize) || 1));
  const groups = [];
  for (let start = 0; start < storyboard.length; start += size) {
    const groupShots = storyboard.slice(start, start + size);
    const first = groupShots[0];
    const last = groupShots[groupShots.length - 1] || first;
    const assets = sortWorkflowVideoAssetsByFileName(
      uniqueWorkflowVideoAssets(groupShots.flatMap((shot) => workflowEcommerceVideoAssetsForShot(shot, imageAssets))),
      workflowVideoAssetDownloadFileName,
    );
    const firstAsset = assets[0] || {};
    const storyboardDetail = groupShots.map((shot) => shot.text).filter(Boolean).join("\n\n");
    groups.push({
      id: createWorkflowLocalId(),
      shotId: `ecommerce-shot-${first.index}`,
      shotIds: groupShots.map((shot) => String(shot.index)),
      index: groups.length + 1,
      startIndex: first.index,
      endIndex: last.index,
      title: first.index === last.index ? first.title : `第 ${first.index}-${last.index} 镜`,
      storyboardDetail,
      script: storyboardDetail,
      groupSize: groupShots.length,
      shotDurationSeconds: Math.max(1, Number(shotDurationSeconds) || 5),
      imageUrl: firstAsset.imageUrl || "",
      imageThumbnailUrl: firstAsset.imageThumbnailUrl || firstAsset.thumbnailUrl || "",
      imagePrompt: storyboardDetail,
      assets,
      videoPrompt: "",
      ecommerceStoryboard: true,
    });
  }
  return groups;
}

function ecommerceStoryboardShots(content = "") {
  const detail = ecommerceScriptShotDetailText(content) || stringFromWorkflowValue(content);
  if (!detail) return [];
  const normalized = detail.replace(/\r\n/g, "\n").trim();
  const pattern = /第\s*(\d+)\s*镜\s*[：:]\s*([^\n]*)([\s\S]*?)(?=\n\s*第\s*\d+\s*镜\s*[：:]|$)/g;
  const shots = [];
  let match;
  while ((match = pattern.exec(normalized))) {
    const index = Number(match[1]) || shots.length + 1;
    const heading = stringFromWorkflowValue(match[2]).trim();
    const body = stringFromWorkflowValue(match[3]).trim();
    const text = [`第 ${index} 镜：${heading}`, body].filter(Boolean).join("\n").trim();
    shots.push({
      index,
      heading,
      sceneName: heading.split(/[\/／]/)[0]?.trim() || "",
      title: heading ? `第 ${index} 镜：${heading}` : `第 ${index} 镜`,
      text,
    });
  }
  return shots;
}

function workflowEcommerceVideoAssetsForShot(storyboardShot = {}, imageAssets = []) {
  const textKey = normalizeWorkflowAssetMatchText(`${storyboardShot.title}\n${storyboardShot.text}`);
  const shotLabel = `第${Number(storyboardShot.index) || 0}镜`;
  const sceneAssets = imageAssets.filter((shot) => shot?.assetType === "scene" && workflowShotImageUrl(shot));
  const roleAssets = imageAssets.filter((shot) => shot?.assetType === "role" && workflowShotImageUrl(shot));
  const productAssets = imageAssets.filter((shot) => shot?.assetType === "product" && workflowShotImageUrl(shot));
  const refMatchedScenes = sceneAssets.filter((asset) => workflowEcommerceAssetHasShotRef(asset, storyboardShot.index));
  const textMatchedScenes = sceneAssets.filter((asset) => {
    const labels = ecommerceSceneMappingShotLabels(asset.sceneMapping);
    if (labels.includes(shotLabel)) return true;
    const titleKey = normalizeWorkflowAssetMatchText(asset.title);
    return titleKey && textKey.includes(titleKey);
  });
  const rawText = `${storyboardShot.title}\n${storyboardShot.text}`;
  const refMatchedRoles = roleAssets.filter((asset) => workflowEcommerceAssetHasShotRef(asset, storyboardShot.index));
  const textMatchedRoles = roleAssets.filter((asset) => !workflowShotIsOutfitVariant(asset) && workflowEcommerceRoleAssetMatchesShot(asset, textKey, rawText));
  const refMatchedProducts = productAssets.filter((asset) => workflowEcommerceAssetHasShotRef(asset, storyboardShot.index));
  const textMatchedProducts = productAssets.filter((asset) => workflowEcommerceProductAssetMatchesShot(asset, textKey, rawText));
  const matchedScenes = refMatchedScenes.length ? refMatchedScenes : textMatchedScenes;
  const matchedRoles = workflowEcommercePruneBaseRolesWithOutfitVariants(
    workflowEcommerceResolveBaseStateRoleAssets(refMatchedRoles.length ? refMatchedRoles : textMatchedRoles, roleAssets),
    roleAssets
  );
  const matchedProducts = refMatchedProducts.length ? refMatchedProducts : textMatchedProducts;
  return [...matchedScenes, ...matchedRoles, ...matchedProducts].map((asset, assetIndex) => {
    const assetType = asset.assetType || "";
    const title = asset.title || asset.roleKey || asset.sceneMapping || `素材 ${assetIndex + 1}`;
    return {
    shotId: workflowShotId(asset),
    index: Number(storyboardShot.index) || assetIndex + 1,
    title: assetType === "scene" ? cleanEcommerceAssetDisplayTitle(title) : title,
    assetType,
    assetRef: asset.assetRef || "",
    roleKey: asset.roleKey || "",
    matchAliases: Array.isArray(asset.matchAliases) ? asset.matchAliases : [],
    shotRefs: Array.isArray(asset.shotRefs) ? asset.shotRefs : [],
    imageUrl: workflowShotImageUrl(asset),
    imageThumbnailUrl: workflowShotThumbnailUrl(asset),
    imagePrompt: stringFromWorkflowValue(asset.imagePrompt || asset.prompt || asset.description),
    };
  });
}

function workflowEcommerceRoleAssetMatchesShot(asset = {}, textKey = "", rawText = "") {
  const aliases = [
    asset.title,
    asset.roleKey,
    ...(Array.isArray(asset.matchAliases) ? asset.matchAliases : []),
  ]
    .map(normalizeWorkflowAssetMatchText)
    .filter((item) => item && item.length >= 2);
  if (aliases.some((alias) => textKey.includes(alias))) return true;

  const profileText = `${asset.title || ""} ${asset.imagePrompt || ""}`;
  if (/(老太|老太太|老人|老母亲|婆婆|奶奶|母亲|老年)/.test(rawText) && /(董事长|老总|银发|白发|老年|老人|老太|老太太|婆婆|奶奶|母亲)/.test(profileText)) {
    return true;
  }
  return false;
}

function workflowEcommerceResolveBaseStateRoleAssets(assets = [], roleAssets = []) {
  return (Array.isArray(assets) ? assets : []).map((asset) => {
    if (!workflowShotIsOutfitVariant(asset)) return asset;
    const baseRole = workflowEcommerceBaseRoleForOutfitVariant(asset, roleAssets);
    if (!baseRole || !workflowShotImageUrl(baseRole)) return asset;
    const variantState = workflowRoleOutfitStateKey(`${asset.outfitVariantName || ""} ${asset.title || ""} ${asset.imagePrompt || asset.prompt || ""}`);
    const baseState = workflowRoleBaseOutfitStateKey(baseRole);
    return (variantState && baseState && variantState === baseState) || workflowEcommerceOutfitVariantCoversBaselineShot(asset, baseRole, roleAssets)
      ? baseRole
      : asset;
  });
}

function workflowEcommercePruneBaseRolesWithOutfitVariants(assets = [], roleAssets = []) {
  const baseRefsWithVariant = new Set();
  (Array.isArray(assets) ? assets : []).forEach((asset) => {
    if (!workflowShotIsOutfitVariant(asset)) return;
    const baseRole = workflowEcommerceBaseRoleForOutfitVariant(asset, roleAssets);
    const baseRef = normalizeWorkflowAssetMatchText(workflowShotAssetRef(baseRole || {}, 0) || asset.outfitVariantOf || "");
    if (baseRef) baseRefsWithVariant.add(baseRef);
  });
  if (!baseRefsWithVariant.size) return assets;
  return (Array.isArray(assets) ? assets : []).filter((asset) => {
    if (workflowShotIsOutfitVariant(asset)) return true;
    const assetRef = normalizeWorkflowAssetMatchText(workflowShotAssetRef(asset, 0));
    return !assetRef || !baseRefsWithVariant.has(assetRef);
  });
}

function workflowEcommerceBaseRoleForOutfitVariant(asset = {}, roleAssets = []) {
  const baseRef = normalizeWorkflowAssetMatchText(asset.outfitVariantOf || "");
  if (!baseRef) return null;
  return (Array.isArray(roleAssets) ? roleAssets : []).find((role) => {
    if (workflowShotIsOutfitVariant(role)) return false;
    return ecommerceAssetRefAliases(role)
      .map(normalizeWorkflowAssetMatchText)
      .filter(Boolean)
      .some((alias) => alias === baseRef || alias.includes(baseRef) || baseRef.includes(alias));
  }) || null;
}

function workflowEcommerceOutfitVariantCoversBaselineShot(asset = {}, baseRole = {}, roleAssets = []) {
  const baseRef = normalizeWorkflowAssetMatchText(asset.outfitVariantOf || "");
  if (!baseRef) return false;
  const variants = (Array.isArray(roleAssets) ? roleAssets : []).filter((role) => (
    workflowShotIsOutfitVariant(role)
    && normalizeWorkflowAssetMatchText(role.outfitVariantOf || "") === baseRef
  ));
  if (variants.length < 2) return false;
  const allShotRefs = [baseRole, ...variants]
    .flatMap((role) => Array.isArray(role.shotRefs) ? role.shotRefs : [])
    .map(Number)
    .filter((shotRef) => Number.isInteger(shotRef) && shotRef > 0);
  const firstShot = Math.min(...allShotRefs);
  if (!Number.isFinite(firstShot)) return false;
  const assetShotRefs = (Array.isArray(asset.shotRefs) ? asset.shotRefs : []).map(Number);
  return assetShotRefs.includes(firstShot);
}

function workflowRoleBaseOutfitStateKey(role = {}) {
  const keys = workflowRoleOutfitStateKeys(`${role.title || ""} ${role.name || ""} ${role.imagePrompt || role.prompt || role.description || ""}`);
  return keys.length === 1 ? keys[0] : "";
}

function workflowRoleOutfitStateKey(value = "") {
  return workflowRoleOutfitStateKeys(value)[0] || "";
}

function workflowRoleOutfitStateKeys(value = "") {
  const text = stringFromWorkflowValue(value);
  const keys = [];
  if (/落魄|装穷|破产|假破产|伪装破产|朴素|旧衣|破旧|寒酸|穷|贫穷|布鞋|旧布鞋|灰色外套|保姆服|打发|50元|五十元|500元|五百元/.test(text)) keys.push("poor");
  if (/富有|富豪|有钱|董事长|集团|高端|西装|正装|光鲜|体面|豪华|阔太|恢复身份|真实身份|继承权/.test(text)) keys.push("rich");
  if (/受伤|血迹|伤痕|淤青|脏污/.test(text)) keys.push("injured");
  if (/病号服|病服|住院|病人/.test(text)) keys.push("hospital");
  if (/制服|工装|工作服|职业装/.test(text)) keys.push("uniform");
  if (/礼服|婚纱|旗袍|汉服|晚宴/.test(text)) keys.push("formal");
  if (/年轻|少年|青年|变年轻/.test(text)) keys.push("young");
  if (/老年|变老|年迈|白发/.test(text)) keys.push("old");
  return [...new Set(keys)];
}

function workflowEcommerceProductAssetMatchesShot(asset = {}, textKey = "", rawText = "") {
  const aliases = workflowEcommerceProductAliasTerms(asset)
    .map(normalizeWorkflowAssetMatchText)
    .filter((item) => item && item.length >= 2);
  return aliases.some((alias) => textKey.includes(alias));
}

function workflowEcommerceTimelineProductAssetMatchesShot(asset = {}, item = {}, textKey = "", rawText = "") {
  if (workflowEcommerceAssetHasShotRef(asset, item.startIndex, item.endIndex, item.shotIds)) return true;
  return workflowEcommerceProductAssetMatchesShot(asset, textKey, rawText);
}

function workflowEcommerceAssetHasShotRef(asset = {}, startIndex = 0, endIndex = startIndex, shotIds = []) {
  const refs = Array.isArray(asset.shotRefs)
    ? asset.shotRefs.map(Number).filter((shotRef) => Number.isFinite(shotRef) && shotRef > 0)
    : [];
  if (!refs.length) return false;
  const explicitShotIds = new Set((Array.isArray(shotIds) ? shotIds : []).map(Number).filter((shotId) => Number.isFinite(shotId) && shotId > 0));
  const start = Number(startIndex) || 0;
  const end = Number(endIndex) || start;
  return refs.some((shotRef) => (
    explicitShotIds.has(shotRef)
    || (start && end && shotRef >= Math.min(start, end) && shotRef <= Math.max(start, end))
    || (start && shotRef === start)
  ));
}

function workflowEcommerceProductAliasTerms(asset = {}) {
  const title = stringFromWorkflowValue(asset.title || asset.name).trim();
  if (!title) return [];
  const blocked = new Set(["产品", "商品", "带货", "使用", "效果", "卖点", "亮点", "视频", "未提及", "适合", "人群", "价格", "资料", "信息", "活动价", "包邮"]);
  const terms = title
    .split(/[\s,，、。；;：:|/／()（）【】\[\]「」『』"'“”‘’]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2 && item.length <= 20 && !blocked.has(item));
  const titleKey = normalizeWorkflowAssetMatchText(title);
  const categoryCandidates = ["蒸汽眼罩", "叶黄素眼罩", "护眼贴", "眼罩", "面膜", "精华液", "精华", "口红", "唇膏", "牙膏", "牙刷", "洗发水", "护发素", "枕头", "零食", "饼干", "咖啡", "茶"];
  const modifierCandidates = ["叶黄素", "蒸汽", "热敷", "恒温", "护眼", "补水", "保湿", "美白", "祛痘", "抗皱", "修护", "清洁"];
  const categories = categoryCandidates.filter((item) => titleKey.includes(normalizeWorkflowAssetMatchText(item)));
  const endingCategories = categories.filter((item) => titleKey.endsWith(normalizeWorkflowAssetMatchText(item)));
  const primaryCategory = endingCategories[0] || categories[0] || "";
  const baseCategory = endingCategories[endingCategories.length - 1] || primaryCategory;
  const categoryIndex = primaryCategory ? titleKey.indexOf(normalizeWorkflowAssetMatchText(primaryCategory)) : -1;
  const prefix = categoryIndex > 0 ? titleKey.slice(0, categoryIndex) : "";
  const brand = prefix
    ? modifierCandidates.reduce((value, modifier) => value.replace(new RegExp(normalizeWorkflowAssetMatchText(modifier), "g"), ""), prefix)
    : "";
  const derived = [];
  if (brand && brand.length >= 2 && brand.length <= 12) derived.push(brand);
  categories.forEach((category) => derived.push(category));
  if (brand && baseCategory) {
    derived.push(`${brand}${baseCategory}`);
    if (primaryCategory && primaryCategory !== baseCategory) derived.push(`${brand}${primaryCategory}`);
    categories.forEach((category) => derived.push(`${brand}${category}`));
  }
  if (baseCategory) {
    modifierCandidates
      .filter((modifier) => titleKey.includes(normalizeWorkflowAssetMatchText(modifier)))
      .forEach((modifier) => derived.push(`${modifier}${baseCategory}`));
  }
  return [...new Set([title, ...terms, ...derived].filter((item) => item && !blocked.has(item)))];
}

function uniqueWorkflowVideoAssets(assets = []) {
  const seen = new Set();
  return assets.filter((asset) => {
    const key = asset.shotId || asset.imageUrl || `${asset.assetType || "asset"}:${asset.title || asset.imagePrompt || ""}`;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeWorkflowAssetMatchText(value = "") {
  return stringFromWorkflowValue(value).replace(/[\s。！？!?；;，,：:、.（）()【】\[\]「」《》\/／]/g, "").toLowerCase();
}

function workflowVideoMaterialAssetCount(run) {
  return (run?.videoTimeline || []).reduce((sum, item) => sum + workflowVideoSegmentAssets(item).length, 0);
}

function workflowVideoMaterialsZipPayload(run) {
  const folder = workflowVideoZipBaseName(run);
  const timeline = Array.isArray(run?.videoTimeline) ? run.videoTimeline : [];
  return {
    folder,
    fileName: folder,
    files: timeline.flatMap((item, itemIndex) =>
      workflowVideoMaterialAssets(item, itemIndex).map(({ asset, fileName }, assetIndex) => {
        return {
          url: asset.imageUrl,
          name: fileName,
          label: workflowVideoAssetDisplayName(asset, assetIndex),
          prompt: asset.imagePrompt,
        };
      })),
    sheet: {
      name: "视频任务",
      headers: ["提示词", "时长", "参考图片", "参考视频", "参考音频", "画面比例", "参考模式"],
      rows: workflowVideoMaterialRows(run),
    },
  };
}

function workflowVideoMaterialRows(run) {
  return (run?.videoTimeline || []).map((item, index) => {
    const imageFiles = workflowVideoMaterialAssets(item, index).map(({ fileName }) => fileName);
    return [
      workflowVideoMaterialPromptText(item, index),
      workflowVideoSegmentDurationText(item),
      imageFiles.join("；"),
      "",
      "",
      "9:16",
      "参考生视频",
    ];
  });
}

function workflowVideoMaterialPromptText(item = {}, index = 0) {
  const prompt = stringFromWorkflowValue(item.videoPrompt).trim();
  if (!prompt) return "";
  const startNumber = workflowVideoSegmentStartNumber(item, index);
  const prefix = `${startNumber}.`;
  const duplicatePrefixPattern = new RegExp(`^${escapeWorkflowRegExp(String(startNumber))}\\s*[.．。]\\s*`);
  return duplicatePrefixPattern.test(prompt) ? prompt : `${prefix} ${prompt}`;
}

function workflowVideoSegmentStartNumber(item = {}, index = 0) {
  const assets = workflowVideoSegmentAssets(item);
  const numericShotIds = Array.isArray(item.shotIds)
    ? item.shotIds.map((shotId) => Number(shotId)).filter((shotId) => Number.isFinite(shotId) && shotId > 0)
    : [];
  const directCandidates = [item.startIndex, assets[0]?.index, numericShotIds[0]];
  for (const candidate of directCandidates) {
    const number = Number(candidate);
    if (Number.isFinite(number) && number > 0) return number;
  }
  const endIndex = Number(item.endIndex);
  const groupSize = Number(item.groupSize || (Array.isArray(item.shotIds) ? item.shotIds.length : 0));
  if (Number.isFinite(endIndex) && endIndex > 0 && Number.isFinite(groupSize) && groupSize > 0) {
    return Math.max(1, endIndex - groupSize + 1);
  }
  if (Number.isFinite(groupSize) && groupSize > 1) return (index * groupSize) + 1;
  const itemIndex = Number(item.index);
  if (Number.isFinite(itemIndex) && itemIndex > 0) return itemIndex;
  return index + 1;
}

function workflowVideoMaterialAssets(item = {}, itemIndex = 0) {
  const usedNames = new Map();
  return workflowVideoSegmentAssets(item).map((asset, assetIndex) => {
    const baseName = safeWorkflowVideoDownloadName(workflowVideoAssetDisplayName(asset, assetIndex), "图片");
    const usedCount = Number(usedNames.get(baseName) || 0) + 1;
    usedNames.set(baseName, usedCount);
    const name = usedCount > 1 ? `${baseName}-${usedCount}` : baseName;
    return {
      asset,
      fileName: workflowVideoMaterialImageName(asset, item, itemIndex, name),
    };
  });
}

function workflowVideoMaterialImageName(asset, item = null, itemIndex = 0, assetName = "") {
  const name = stringFromWorkflowValue(assetName || workflowVideoAssetDisplayName(asset, 0)).trim() || "图片";
  return workflowVideoMaterialImagePath({
    item,
    itemIndex,
    assetName: name,
    extension: workflowImageExtensionFromSource(asset.imageUrl),
  });
}

function workflowVideoSegmentDurationText(item = {}) {
  const explicitDurationSeconds = Number(item.durationSeconds);
  if (Number.isFinite(explicitDurationSeconds) && explicitDurationSeconds > 0) {
    const rounded = Math.round(explicitDurationSeconds * 10) / 10;
    return `${rounded}s`;
  }
  const shotCount = Number(item.groupSize || (Array.isArray(item.shotIds) ? item.shotIds.length : 0) || (Number(item.endIndex) && Number(item.startIndex) ? Number(item.endIndex) - Number(item.startIndex) + 1 : 1)) || 1;
  const shotDurationSeconds = Math.max(1, Number(item.shotDurationSeconds) || 5);
  return `${Math.max(1, shotCount) * shotDurationSeconds}s`;
}

function workflowStoryboardShotDurationSeconds(workflow = {}) {
  const type = stringFromWorkflowValue(workflow?.type || workflow?.workflowType || workflow?.config?.type);
  const topicMode = stringFromWorkflowValue(workflow?.topicMode || workflow?.config?.topicMode);
  if (type !== "ecommerce" || topicMode !== "script") return 5;
  return 4.5;
}

function workflowVideoGenerateDialogState(item, index, candidates = [], options = {}) {
  const candidate = candidates[0] || {};
  const model = candidate.model || workflowVideoModels[0];
  const prompt = workflowVideoPromptForItem(item);
  const targets = Array.isArray(options.targets) && options.targets.length
    ? options.targets
    : [workflowVideoTargetFromTimelineItem(item, index)];
  return {
    mode: options.mode || "single",
    item,
    index,
    timelineItemId: workflowTimelineItemId(item, index),
    title: workflowVideoSegmentLabel(item, index),
    targets,
    apiKeyId: candidate.apiKey?.id || "",
    modelId: model?.id || "",
    modelProvider: model?.provider || "",
    ratio: workflowVideoOptionFirstValue(model?.ratios) || "9:16",
    duration: workflowVideoDefaultDuration(model, item),
    generationMode: workflowVideoOptionFirstValue(model?.modes) || "all-reference",
    resolution: model?.resolutions?.[0] || "720p",
    prompt,
  };
}

function workflowVideoPromptForItem(item = {}) {
  return stringFromWorkflowValue(item?.videoPrompt).trim() || workflowVideoSegmentPrompt(item).trim();
}

function workflowVideoDialogTargets(dialog = {}) {
  if (Array.isArray(dialog.targets) && dialog.targets.length) return dialog.targets;
  if (!dialog.item) return [];
  return [workflowVideoTargetFromTimelineItem(dialog.item, dialog.index)];
}

function workflowVideoTargetFromTimelineItem(item = {}, index = 0) {
  return {
    item,
    index,
    timelineItemId: workflowTimelineItemId(item, index),
    title: workflowVideoSegmentLabel(item, index),
  };
}

function workflowVideoDialogForTarget(dialog = {}, target = {}, prompt = "") {
  return {
    ...dialog,
    item: target.item,
    index: target.index,
    timelineItemId: target.timelineItemId,
    title: target.title,
    prompt,
  };
}

function workflowVideoDefaultDuration(model = {}, item = {}) {
  const durations = Array.isArray(model.durations) ? model.durations : [];
  const segmentDuration = workflowVideoSegmentDurationText(item);
  if (durations.includes(segmentDuration)) return segmentDuration;
  const seconds = Number(String(segmentDuration).match(/\d+/)?.[0] || 0);
  const bounds = workflowVideoDurationBounds(durations);
  const clamped = seconds ? `${Math.max(bounds.min, Math.min(bounds.max, seconds))}s` : "";
  return optionValueOrFirst(durations, clamped) || durations[0] || "5s";
}

function workflowVideoDurationBounds(durations = []) {
  const seconds = (Array.isArray(durations) ? durations : [])
    .map((duration) => Number(String(duration || "").match(/\d+/)?.[0] || 0))
    .filter((duration) => Number.isFinite(duration) && duration > 0);
  if (!seconds.length) return { min: 5, max: 15 };
  return { min: Math.min(...seconds), max: Math.max(...seconds) };
}

function workflowVideoReferenceUrlsForItem(item = {}, model = {}, generationMode = "") {
  const references = workflowVideoSegmentAssets(item).map(asset => asset.imageUrl).filter(Boolean);
  const mode = stringFromWorkflowValue(generationMode || model.modes?.[0]?.value).toLowerCase();
  if (mode === "text") return [];
  if (mode === "first-last-frame") return references.slice(0, 2);
  if (mode !== "all-reference") return references.slice(0, 1);
  return references.slice(0, Math.max(1, Number(model.referenceLimit) || 1));
}

function workflowVideoRequiredReferenceCount(model = {}, generationMode = "") {
  const mode = stringFromWorkflowValue(generationMode || model.modes?.[0]?.value).toLowerCase();
  return mode === "text" ? 0 : mode === "first-last-frame" ? 2 : 1;
}

function workflowVideoReferenceUrlsFromResult(video = {}) {
  const values = [video.referenceImageUrls, video.references, video.frames]
    .find((value) => Array.isArray(value)) || [];
  return values
    .map((url) => typeof url === "string" ? url : url?.fileUrl || url?.url || url?.dataUrl || "")
    .map((url) => stringFromWorkflowValue(url).trim())
    .filter(Boolean);
}

function workflowVideoMissingTargets(timeline = [], results = []) {
  const resultList = Array.isArray(results) ? results : [];
  return (Array.isArray(timeline) ? timeline : [])
    .map((item, index) => workflowVideoTargetFromTimelineItem(item, index))
    .filter((target) => !resultList.some((video) => workflowVideoResultMatchesTarget(video, target) && workflowVideoResultBlocksMissing(video)));
}

function workflowVideoResultMatchesTarget(video = {}, target = {}) {
  const targetId = stringFromWorkflowValue(target.timelineItemId);
  const videoTimelineId = stringFromWorkflowValue(video?.timelineItemId);
  if (targetId && videoTimelineId && targetId === videoTimelineId) return true;
  const title = stringFromWorkflowValue(target.title);
  return Boolean(title && stringFromWorkflowValue(video?.title) === title);
}

function workflowVideoResultBlocksMissing(video = {}) {
  const category = workflowVideoResultCategory(video);
  return category === "done" || category === "processing";
}

function workflowVideoResultFromDialog(dialog = {}, candidate = {}, options = {}) {
  const now = new Date().toISOString();
  const references = Array.isArray(options.references) ? options.references : [];
  const segmentId = dialog.timelineItemId || workflowTimelineItemId(dialog.item, dialog.index);
  return {
    id: createWorkflowLocalId(),
    timelineItemId: segmentId,
    title: dialog.title || workflowVideoSegmentLabel(dialog.item, dialog.index),
    prompt: stringFromWorkflowValue(dialog.prompt).trim(),
    status: options.status || "queued",
    videoUrl: "",
    error: "",
    taskId: "",
    upstreamStatus: "",
    submittedAt: "",
    lastQueriedAt: "",
    apiKeyId: candidate.apiKey?.id || "",
    apiKeyName: apiKeyDisplayName(candidate.apiKey),
    channel: candidate.apiKey?.channel || candidate.model?.channel || "",
    provider: candidate.model?.provider || "",
    modelName: candidate.model?.name || "",
    modelId: candidate.model?.modelId || candidate.model?.id || "",
    modelOptionId: candidate.model?.id || "",
    ratio: dialog.ratio || "9:16",
    duration: dialog.duration || "5s",
    resolution: dialog.resolution || "720p",
    generationMode: dialog.generationMode || "all-reference",
    referenceImageUrls: references,
    shotIds: Array.isArray(dialog.item?.shotIds) ? dialog.item.shotIds : [],
    startIndex: dialog.item?.startIndex || 0,
    endIndex: dialog.item?.endIndex || 0,
    createdAt: now,
    updatedAt: now,
  };
}

function workflowVideoResultFromToolResult(video = {}, result = {}) {
  const data = result?.data && typeof result.data === "object" ? result.data : result;
  const videoUrl = workflowVideoUrl(data) || workflowVideoUrl(video);
  const taskId = stringFromWorkflowValue(data?.taskId || data?.id || video.taskId || video?.meta?.taskId);
  const providerStatus = stringFromWorkflowValue(data?.status || data?.state || data?.data?.status || data?.data?.state || data?.result?.status || data?.result?.state).toLowerCase();
  const rawStatus = providerStatus || stringFromWorkflowValue(video.status).toLowerCase();
  const failed = ["failed", "error", "cancelled", "canceled"].includes(rawStatus);
  const upstreamStatus = providerStatus || stringFromWorkflowValue(video.upstreamStatus || video.providerStatus);
  const nextStatus = videoUrl ? "done" : failed ? "error" : taskId ? "running" : rawStatus || "running";
  const message = stringFromWorkflowValue(data?.message || data?.error?.message || data?.error || video.error);
  const updatedAt = new Date().toISOString();
  return {
    ...video,
    status: nextStatus,
    videoUrl,
    taskId,
    upstreamStatus,
    lastQueriedAt: updatedAt,
    recentQueryError: "",
    queryError: "",
    error: failed ? message || "视频任务生成失败。" : "",
    message: failed ? "" : message,
    rawFields: Array.isArray(data?.rawFields) ? data.rawFields : video.rawFields || [],
    updatedAt,
    completedAt: videoUrl ? updatedAt : video.completedAt || "",
  };
}

function workflowVideoResultId(video) {
  if (!video || typeof video !== "object") return "";
  return workflowVideoResultInstanceId(video) || stringFromWorkflowValue(video.timelineItemId);
}

function workflowVideoSelectableId(video, index = 0) {
  return workflowVideoResultId(video) || `${workflowVideoUrl(video) || "video"}-${index}`;
}

function workflowVideoResultStatus(video = {}) {
  if (workflowVideoUrl(video)) return "done";
  return stringFromWorkflowValue(video?.status).toLowerCase() || "pending";
}

function workflowVideoStatusIsDone(status = "") {
  return ["done", "completed"].includes(status);
}

function workflowVideoStatusIsQueued(status = "") {
  return ["queued", "pending"].includes(status);
}

function workflowVideoStatusIsRunning(status = "") {
  return ["running", "processing"].includes(status);
}

function workflowVideoStatusIsActive(status = "") {
  return workflowVideoStatusIsQueued(status) || workflowVideoStatusIsRunning(status);
}

function workflowVideoStatusIsFailed(status = "") {
  return ["error", "failed", "cancelled", "canceled"].includes(status);
}

function workflowVideoResultCategory(video = {}) {
  const status = workflowVideoResultStatus(video);
  if (workflowVideoStatusIsDone(status)) return "done";
  if (workflowVideoStatusIsFailed(status)) return "failed";
  return "processing";
}

function workflowVideoResultCategoryCounts(results = []) {
  return (Array.isArray(results) ? results : []).reduce((counts, video) => {
    counts[workflowVideoResultCategory(video)] += 1;
    return counts;
  }, { done: 0, processing: 0, failed: 0 });
}

function workflowVideoDefaultCategory(results = []) {
  const counts = workflowVideoResultCategoryCounts(results);
  if (counts.processing) return "processing";
  if (counts.done) return "done";
  if (counts.failed) return "failed";
  return "processing";
}

function workflowVideoResultNeedsPolling(video = {}) {
  const status = workflowVideoResultStatus(video);
  return Boolean(
    video?.apiKeyId
    && (video?.taskId || video?.meta?.taskId)
    && !workflowVideoUrl(video)
    && workflowVideoStatusIsActive(status),
  );
}

function workflowVideoResultStatusLabel(video = {}) {
  const status = workflowVideoResultStatus(video);
  if (workflowVideoStatusIsDone(status)) return "已完成";
  if (workflowVideoResultIsPausedQueued(video)) return "队列已暂停";
  if (workflowVideoStatusIsQueued(status)) return "排队中";
  if (workflowVideoStatusIsRunning(status)) return "生成中";
  if (workflowVideoResultIsSubmissionUnknown(video)) return "提交状态未知";
  if (workflowVideoStatusIsFailed(status)) return "生成失败";
  return workflowStatusLabel(status);
}

function workflowVideoResultStatusTone(video = {}) {
  const status = workflowVideoResultStatus(video);
  if (workflowVideoStatusIsDone(status)) return "success";
  if (workflowVideoStatusIsFailed(status)) return "error";
  if (workflowVideoStatusIsQueued(status)) return "queued";
  return "running";
}

function workflowVideoStatusMessage(video = {}) {
  const status = workflowVideoResultStatus(video);
  const taskId = stringFromWorkflowValue(video?.taskId || video?.meta?.taskId);
  const upstreamStatus = stringFromWorkflowValue(video?.upstreamStatus || video?.providerStatus);
  if (workflowVideoStatusIsDone(status)) return "视频已生成完成。";
  if (workflowVideoStatusIsFailed(status)) {
    if (workflowVideoResultIsSubmissionUnknown(video)) {
      return taskId
        ? "任务提交状态曾中断，可再次查询上游结果尝试恢复。"
        : "任务可能已提交到模型渠道，但本地没有拿到任务 ID。请勿重复提交，可从渠道后台补录 task_id 后恢复查询。";
    }
    return stringFromWorkflowValue(video.error || video.message) || "视频生成失败。";
  }
  if (workflowVideoStatusIsQueued(status)) {
    if (workflowVideoResultIsPausedQueued(video)) return stringFromWorkflowValue(video.queuePauseReason) || "提交状态未知，已暂停后续自动提交。";
    if (!taskId) return "视频任务已排队，等待提交到模型服务。";
    return upstreamStatus ? `任务已提交，上游状态：${upstreamStatus}。` : "任务已排队，等待模型服务处理。";
  }
  if (!taskId) return stringFromWorkflowValue(video.message) || "正在提交到模型服务。";
  if (upstreamStatus) return stringFromWorkflowValue(video.message) || `模型正在生成视频，上游状态：${upstreamStatus}。`;
  return stringFromWorkflowValue(video.message) || "模型正在生成视频。";
}

function workflowVideoResultIsSubmissionUnknown(video = {}) {
  const status = workflowVideoResultStatus(video);
  if (!workflowVideoStatusIsFailed(status)) return false;
  if (stringFromWorkflowValue(video?.submissionState).toLowerCase() === "unknown") return true;
  if (stringFromWorkflowValue(video?.submissionErrorKind).toLowerCase() === "submission-unknown") return true;
  const message = stringFromWorkflowValue(video.error || video.message || video.recentQueryError || video.queryError);
  return /HTTP\s*(408|500|502|503|504)|网络连接失败|请求超时|模型请求可能已经提交|上游可能已经创建任务|没有解析到视频任务 ID|failed to fetch|networkerror|load failed|fetch/i.test(message);
}

function workflowVideoResultIsPausedQueued(video = {}) {
  return Boolean(video?.queuePaused && workflowVideoStatusIsQueued(workflowVideoResultStatus(video)) && !workflowVideoUrl(video));
}

function workflowVideoStageFromResults(results = [], timeline = []) {
  const list = Array.isArray(results) ? results : [];
  if (!list.length) return "pending";
  const statuses = list.map(workflowVideoResultStatus);
  if (statuses.some(workflowVideoStatusIsRunning)) return "running";
  if (statuses.some(workflowVideoStatusIsQueued)) return "queued";

  const targets = (Array.isArray(timeline) ? timeline : []).map((item, index) => workflowVideoTargetFromTimelineItem(item, index));
  if (targets.length) {
    const completedTargets = targets.filter((target) =>
      list.some((video) => workflowVideoResultMatchesTarget(video, target) && workflowVideoStatusIsDone(workflowVideoResultStatus(video))));
    if (completedTargets.length === targets.length) return "done";
    if (completedTargets.length || statuses.some(workflowVideoStatusIsDone)) return "partial";
    if (statuses.some(workflowVideoStatusIsFailed)) return "error";
    return "pending";
  }

  if (statuses.every(workflowVideoStatusIsDone)) return "done";
  if (statuses.some(workflowVideoStatusIsDone)) return "partial";
  if (statuses.some(workflowVideoStatusIsFailed)) return "error";
  return "pending";
}

function workflowVideoResultsSummaryText(results = []) {
  const list = Array.isArray(results) ? results : [];
  const counts = list.reduce((acc, video) => {
    const status = workflowVideoResultStatus(video);
    if (workflowVideoStatusIsDone(status)) acc.done += 1;
    else if (workflowVideoStatusIsFailed(status)) acc.error += 1;
    else if (workflowVideoStatusIsQueued(status)) acc.queued += 1;
    else acc.running += 1;
    return acc;
  }, { done: 0, running: 0, queued: 0, error: 0 });
  const parts = [
    counts.done ? `${counts.done} 个已完成` : "",
    counts.running ? `${counts.running} 个生成中` : "",
    counts.queued ? `${counts.queued} 个排队中` : "",
    counts.error ? `${counts.error} 个失败` : "",
  ].filter(Boolean);
  return parts.length ? `共 ${list.length} 个视频任务，${parts.join("，")}。` : `共 ${list.length} 个视频任务。`;
}

function workflowVideoResultsWithout(results = [], video = {}, index = -1) {
  const targetId = workflowVideoResultId(video);
  return (Array.isArray(results) ? results : []).filter((item, itemIndex) => (
    targetId ? workflowVideoResultId(item) !== targetId : itemIndex !== index
  ));
}

function workflowVideoResultsWithoutMany(results = [], videos = []) {
  const selectedIds = new Set(videos.map(workflowVideoResultId).filter(Boolean));
  const selectedSet = new Set(videos);
  return (Array.isArray(results) ? results : []).filter((item) => {
    const id = workflowVideoResultId(item);
    return id ? !selectedIds.has(id) : !selectedSet.has(item);
  });
}

function workflowVideoDownloadZipPayload(run = {}, videos = []) {
  const usedNames = new Map();
  const files = videos
    .map((video, index) => {
      const url = workflowVideoUrl(video);
      if (!url) return null;
      const baseName = uniqueWorkflowVideoDownloadName(workflowVideoDownloadBaseName(video, index), usedNames);
      return {
        url,
        name: `${baseName}.${workflowVideoFileExtension(url)}`,
        label: workflowVideoTitle(video, index),
      };
    })
    .filter(Boolean);
  const folder = safeWorkflowVideoDownloadName(`${workflowRunShortId(run)}-视频结果`, "视频结果");
  return {
    folder,
    fileName: `${folder}-视频结果`,
    manifestName: "视频清单",
    files,
  };
}

function uniqueWorkflowVideoDownloadName(name = "视频", usedNames = new Map()) {
  const cleanName = safeWorkflowVideoDownloadName(name, "视频");
  const nextCount = Number(usedNames.get(cleanName) || 0) + 1;
  usedNames.set(cleanName, nextCount);
  return nextCount > 1 ? `${cleanName}-${nextCount}` : cleanName;
}

function workflowVideoDownloadBaseName(video = {}, index = 0) {
  const raw = stringFromWorkflowValue(video.title || video.name || video.fileName || "").trim();
  const compact = raw.replace(/\s+/g, "");
  const rangeMatch = compact.match(/(?:第|分镜)?0*(\d+)[-~—至到]+0*(\d+)镜?/) || compact.match(/第0*(\d+)镜.*第0*(\d+)镜/);
  if (rangeMatch) return `第${Number(rangeMatch[1])}-${Number(rangeMatch[2])}镜`;
  const singleMatch = compact.match(/(?:第|分镜)?0*(\d+)镜?/);
  if (singleMatch) return `第${Number(singleMatch[1])}镜`;
  return compact || `第${index + 1}镜`;
}

function workflowVideoFileExtension(url = "") {
  const clean = String(url).split("?")[0].split("#")[0];
  const ext = clean.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase();
  return ["mp4", "mov", "webm", "m4v", "avi", "mkv"].includes(ext) ? ext : "mp4";
}

function workflowImageExtensionFromSource(src = "") {
  const dataMatch = String(src).match(/^data:image\/([a-z0-9.+-]+);/i);
  if (dataMatch) return dataMatch[1].replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "") || "png";
  const clean = String(src).split("?")[0].split("#")[0];
  const ext = clean.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase();
  return ["jpg", "jpeg", "png", "webp", "gif", "avif"].includes(ext) ? ext.replace("jpeg", "jpg") : "png";
}

function workflowImageZipPayload(run, shots) {
  const folder = workflowImageZipBaseName(run);
  const parsedScriptByNumber = new Map(
    workflowParsedShotOutput(run)
      .map((shot, index) => [workflowShotNumber(shot, index), workflowShotScriptText(shot)])
      .filter(([, script]) => script),
  );
  const files = shots.map((shot, index) => {
    const shotNumber = workflowShotNumber(shot, index);
    const imageUrl = workflowShotImageUrl(shot);
    const imageName = `images/scene_${shotNumber}.${workflowImageExtensionFromSource(imageUrl)}`;
    return {
      url: imageUrl,
      name: imageName,
      label: `镜头 ${shotNumber}`,
      script: workflowShotScriptText(shot) || parsedScriptByNumber.get(shotNumber) || "",
      prompt: stringFromWorkflowValue(shot.imagePrompt || shot.prompt || shot.description),
    };
  });
  return {
    runId: run.id,
    shotIds: shots.map(workflowShotId).filter(Boolean),
    folder,
    fileName: folder,
    files,
    sheet: {
      name: "shot-image-list",
      headers: ["镜头序号", "图片文件", "对应文案", "图片提示词"],
      rows: files.map((file) => [file.label, file.name, file.script, file.prompt]),
    },
  };
}

function workflowShotScriptText(shot) {
  return stringFromWorkflowValue(shot?.script || shot?.copy || shot?.voiceover || shot?.narration || shot?.correspondingScript || shot?.content || shot?.text);
}

function workflowShotScriptTextForLanguage(shot, language = "zh") {
  const localized = shot?.localizedScripts && typeof shot.localizedScripts === "object" ? shot.localizedScripts : {};
  if (language === "en") {
    return stringFromWorkflowValue(shot?.scriptEn || shot?.englishScript || shot?.script_en || localized.en || localized.english);
  }
  if (language === "zh") {
    return stringFromWorkflowValue(shot?.scriptZh || shot?.chineseScript || shot?.script_zh || localized.zh || localized.cn || localized.chinese);
  }
  return stringFromWorkflowValue(localized[language]);
}

function downloadWorkflowBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName || "分镜图片.zip";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1200);
}

function workflowDelay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function workflowStatusLabel(status) {
  return {
    done: "已完成",
    completed: "已完成",
    running: "执行中",
    error: "有问题",
    failed: "失败",
    partial: "部分完成",
    waiting: "待确认",
    pending: "未开始",
    skipped: "已跳过",
    queued: "排队中",
  }[status] || "未开始";
}

function formatWorkflowDate(value) {
  if (!value) return "未记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未记录";
  return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}`;
}

function formatWorkflowDateTime(value) {
  if (!value) return "未记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未记录";
  return `${formatWorkflowDate(value)} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}:${String(date.getSeconds()).padStart(2, "0")}`;
}
