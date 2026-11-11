"use client";

import { useEffect, useMemo, useState } from "react";
import PageLoading from "../../../components/PageLoading";
import { localizedText, useLanguage } from "../../../components/LanguageProvider";
import { deleteApiKey, getTeamContext, listApiKeys, listProviderCatalog, readAuthToken, saveApiKey } from "../../../lib/flowstudio-api";
import { isRemovedApiChannel } from "../../../lib/api-key-options";

const serviceTypes = [
  { id: "llm", name: { zh: "LLM 服务", en: "LLM Service" }, desc: { zh: "文案、选题、提示词、审核建议", en: "Copywriting, topics, prompts, and review suggestions" } },
  { id: "image", name: { zh: "图片生成", en: "Image Generation" }, desc: { zh: "参考图、分镜图、封面图", en: "Reference images, storyboard images, and covers" } },
  { id: "video", name: { zh: "视频生成", en: "Video Generation" }, desc: { zh: "图生视频、文生视频、镜头片段", en: "Image-to-video, text-to-video, and shot clips" } },
  { id: "audio", name: { zh: "音频生成", en: "Audio Generation" }, desc: { zh: "配音、音效、BGM", en: "Voiceover, sound effects, and BGM" } },
  { id: "draft", name: { zh: "剪辑草稿", en: "Editing Draft" }, desc: { zh: "剪映草稿、时间轴装配、字幕导入", en: "Jianying drafts, timeline assembly, and subtitle import" } },
];

const emptyForm = {
  id: "",
  serviceType: "llm",
  channel: "",
  apiKey: "",
  endpoint: "",
  model: "",
  teamShared: false,
};
const savedDraftKeyMask = "********";
const customChannelDiscardedSecret = "custom-channel-secret-not-stored";

const apiText = {
  loadingKeys: { zh: "正在读取 API Key...", en: "Loading API keys..." },
  synced: { zh: "API Key 已同步。", en: "API keys synced." },
  loadFailed: { zh: "API Key 读取失败。", en: "Unable to load API keys." },
  requiredKey: { zh: "新增 API Key 时必须填写密钥。", en: "An API key is required when adding a new key." },
  customProtocol: { zh: "自定义接口", en: "Custom API" },
  savingEdit: { zh: "正在保存修改...", en: "Saving changes..." },
  savingKey: { zh: "正在保存 API Key...", en: "Saving API key..." },
  saved: { zh: "API Key 已保存到后端加密存储。", en: "API key saved to encrypted backend storage." },
  saveFailed: { zh: "API Key 保存失败。", en: "Unable to save API key." },
  httpsEndpointOnly: { zh: "自定义渠道接口地址只支持 HTTPS 开头的地址。", en: "Custom provider endpoints must start with HTTPS." },
  draftRequired: { zh: "请输入剪辑草稿 API Key。", en: "Enter an editing draft API key." },
  draftUpdating: { zh: "正在更新剪辑草稿配置...", en: "Updating editing draft configuration..." },
  draftSaving: { zh: "正在保存剪辑草稿配置...", en: "Saving editing draft configuration..." },
  draftSaved: { zh: "剪辑草稿配置已保存。", en: "Editing draft configuration saved." },
  draftSaveFailed: { zh: "剪辑草稿配置保存失败。", en: "Unable to save editing draft configuration." },
  editingKey: { zh: "正在编辑", en: "Editing" },
  keepSecret: { zh: "密钥留空会保留原值。", en: "Leave the secret blank to keep the current value." },
  currentService: { zh: "当前服务", en: "Current service" },
  selectedSuffix: { zh: "已选中，可以添加新的 API Key。", en: "selected. You can add a new API key." },
  deleting: { zh: "正在删除 API Key...", en: "Deleting API key..." },
  deleted: { zh: "API Key 已删除。", en: "API key deleted." },
  deleteFailed: { zh: "API Key 删除失败。", en: "Unable to delete API key." },
  title: { zh: "API 配置", en: "API Configuration" },
  description: {
    zh: "添加并管理 LLM、图片生成、视频生成、音频生成和剪辑草稿 API Key。",
    en: "Add and manage API keys for LLM, image generation, video generation, audio generation, and editing drafts.",
  },
  addKey: { zh: "+ 添加 API Key", en: "+ Add API Key" },
  loadingSettings: { zh: "正在读取 API 设置", en: "Loading API settings" },
  overviewAria: { zh: "API 配置概览", en: "API configuration overview" },
  keyCount: { zh: "个 Key", en: "keys" },
  emptyConfig: { zh: "暂无配置", en: "No configuration" },
  editKey: { zh: "编辑 API Key", en: "Edit API Key" },
  addApiKey: { zh: "添加 API Key", en: "Add API Key" },
  close: { zh: "关闭", en: "Close" },
  serviceType: { zh: "服务类型", en: "Service type" },
  channel: { zh: "选择渠道", en: "Provider" },
  customHint: { zh: "自定义渠道需要手动配置接口地址和模型。", en: "Custom providers require endpoint and model configuration." },
  selectedChannelPrefix: { zh: "已选择", en: "Selected" },
  selectedChannelSuffix: { zh: "会按当前服务自动完成配置。", en: "will be configured automatically for the selected service." },
  keepOriginalKey: { zh: "留空则保留原密钥", en: "Leave blank to keep the current key" },
  inputApiKey: { zh: "输入 API Key", en: "Enter API Key" },
  endpoint: { zh: "接口地址", en: "Endpoint" },
  model: { zh: "模型", en: "Model" },
  modelPlaceholder: { zh: "例如 gpt-4o、flux-pro、kling-v1", en: "For example gpt-4o, flux-pro, kling-v1" },
  cancel: { zh: "取消", en: "Cancel" },
  saving: { zh: "保存中...", en: "Saving..." },
  saveEdit: { zh: "保存修改", en: "Save changes" },
  saveKey: { zh: "保存 API Key", en: "Save API Key" },
  deleteTitle: { zh: "删除 API Key", en: "Delete API Key" },
  confirmEyebrow: { zh: "确认操作", en: "Confirm action" },
  deleteConfirmSuffix: { zh: "API Key 吗？删除后引用该 Key 的配置将无法继续使用。", en: "API key? Configurations that reference it will stop working." },
  deletingShort: { zh: "删除中...", en: "Deleting..." },
  teamShare: { zh: "团队共享", en: "Team sharing" },
  teamShareHelp: { zh: "勾选后该 API Key 将供团队成员使用", en: "When enabled, team members can use this API key" },
  teamShareDisabledHelp: { zh: "先到团队空间创建团队后可用", en: "Create a team in Team Workspace to enable this" },
  draftKey: { zh: "剪辑草稿 API Key", en: "Editing draft API Key" },
  draftSave: { zh: "保存剪辑草稿配置", en: "Save editing draft config" },
  apiChannel: { zh: "API 渠道", en: "API Provider" },
  editTitle: { zh: "编辑 API Key", en: "Edit API Key" },
  deleteKeyTitle: { zh: "删除 API Key", en: "Delete API Key" },
  deleteShort: { zh: "删", en: "Del" },
  serviceLabel: { zh: "服务类型", en: "Service type" },
  ownerLabel: { zh: "归属", en: "Owner" },
  team: { zh: "团队共享", en: "Team shared" },
  personal: { zh: "个人", en: "Personal" },
  encrypted: { zh: "后端已加密", en: "Encrypted on backend" },
  storageLabel: { zh: "存储", en: "Storage" },
  backendEncrypted: { zh: "后端加密", en: "Backend encrypted" },
  localDev: { zh: "本地开发", en: "Local development" },
};

export default function ApiSettingsDashboard() {
  const { language, t } = useLanguage();
  const [apiKeys, setApiKeys] = useState([]);
  const [form, setForm] = useState(emptyForm);
  const [providers, setProviders] = useState([]);
  const channelOptions = providers.filter(item => item.serviceType === form.serviceType).map(item => item.channel);
  function getChannelPreset(channel, serviceType) {
    const item = providers.find(item => item.channel === channel && item.serviceType === serviceType);
    return item ? { ...item, models: item.models.map(model => model.id).join(", ") } : null;
  }
  function defaultChannelForService(serviceType) {
    return providers.find(item => item.serviceType === serviceType)?.channel || "";
  }
  const [loadState, setLoadState] = useState("loading");
  const [message, setMessage] = useState(() => t(apiText.loadingKeys));
  const [initialLoading, setInitialLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [teamContext, setTeamContext] = useState(null);

  useEffect(() => {
    if (!readAuthToken()) return;
    let active = true;

    async function loadKeys() {
      setLoadState("loading");
      setMessage(t(apiText.loadingKeys));
      try {
        const [result, teamResult, catalog] = await Promise.all([
          listApiKeys(),
          getTeamContext().catch(() => null),
          listProviderCatalog(),
        ]);
        if (!active) return;
        setApiKeys(Array.isArray(result.apiKeys) ? result.apiKeys : []);
        setTeamContext(teamResult || null);
        setProviders(catalog.providers || []);
        setLoadState("ready");
        setMessage(t(apiText.synced));
      } catch (error) {
        if (!active) return;
        setLoadState("error");
        setMessage(error.message || t(apiText.loadFailed));
      } finally {
        if (active) setInitialLoading(false);
      }
    }

    loadKeys();
    return () => {
      active = false;
    };
  }, []);

  const preset = getChannelPreset(form.channel, form.serviceType);
  const groupedKeys = useMemo(() => {
    return serviceTypes.map((service) => ({
      ...service,
      keys: apiKeys.filter((item) => item.serviceType === service.id && !isRemovedApiChannel(item.channel)),
    }));
  }, [apiKeys]);
  const overviewKeys = useMemo(() => groupedKeys, [groupedKeys]);
  const showInitialLoading = initialLoading && loadState === "loading";
  const draftKey = useMemo(() => apiKeys.find((item) => item.serviceType === "draft") || null, [apiKeys]);

  function updateForm(key, value) {
    setForm((current) => {
      const next = { ...current, [key]: value };
      if (key === "serviceType") {
        next.channel = defaultChannelForService(value);
        next.endpoint = "";
        next.model = "";
      }
      if (key === "channel" && value !== "自定义渠道") {
        next.endpoint = "";
        next.model = "";
      }
      return next;
    });
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!form.id && !form.apiKey.trim()) {
      setLoadState("error");
      setMessage(t(apiText.requiredKey));
      return;
    }

    if (!preset) { setLoadState("error"); setMessage("请先由站点管理员配置此服务的渠道。"); return; }
    const isCustom = form.channel === "自定义渠道";
    if (isCustom && !isHttpsEndpoint(form.endpoint)) {
      setLoadState("error");
      setMessage(t(apiText.httpsEndpointOnly));
      return;
    }
    const payload = {
      id: form.id || crypto.randomUUID(),
      serviceType: form.serviceType,
      channel: form.channel,
      apiKey: isCustom ? customChannelDiscardedSecret : form.apiKey.trim(),
      endpoint: isCustom ? form.endpoint.trim() : preset?.endpoint || "",
      model: isCustom ? form.model.trim() : preset?.models || "",
      authType: isCustom ? "Bearer" : preset?.authType || "Bearer",
      protocol: isCustom ? t(apiText.customProtocol) : preset?.protocol || "",
      teamShared: Boolean(form.teamShared && teamContext?.role === "owner"),
    };

    setSaving(true);
    setLoadState("loading");
    setMessage(form.id ? t(apiText.savingEdit) : t(apiText.savingKey));
    try {
      const result = await saveApiKey(payload);
      mergeSavedApiKey(result.apiKey);
      setForm(emptyForm);
      setDialogOpen(false);
      setLoadState("ready");
      setMessage(t(apiText.saved));
    } catch (error) {
      setLoadState("error");
      setMessage(error.message || t(apiText.saveFailed));
    } finally {
      setSaving(false);
    }
  }

  function mergeSavedApiKey(saved) {
    if (!saved) return;
    setApiKeys((current) => (
      current.some((item) => item.id === saved.id)
        ? current.map((item) => (item.id === saved.id ? saved : item))
        : [saved, ...current]
    ));
  }

  function startEdit(item) {
    setForm({
      id: item.id,
      serviceType: item.serviceType || "llm",
      channel: formatApiChannelName(item.channel || defaultChannelForService(item.serviceType)),
      apiKey: "",
      endpoint: item.endpoint || "",
      model: item.model || "",
      teamShared: item.scope === "team",
    });
    setLoadState("ready");
    setMessage(`${t(apiText.editingKey)} ${formatApiChannelName(item.channel) || "API Key"}. ${t(apiText.keepSecret)}`);
    setDialogOpen(true);
  }

  function startCreate(serviceType = form.serviceType) {
    setForm({ ...emptyForm, serviceType, channel: defaultChannelForService(serviceType), teamShared: false });
    setLoadState("ready");
    const serviceName = localizedText(serviceTypes.find((item) => item.id === serviceType)?.name, language) || t(apiText.currentService);
    setMessage(language === "en" ? `${serviceName} ${t(apiText.selectedSuffix)}` : `${serviceName}${t(apiText.selectedSuffix)}`);
    setDialogOpen(true);
  }

  function closeDialog() {
    setDialogOpen(false);
    setForm(emptyForm);
  }

  function requestDelete(item) {
    setDeleteTarget(item);
  }

  async function handleDelete(item) {
    setDeletingId(item.id);
    setLoadState("loading");
    setMessage(t(apiText.deleting));
    try {
      await deleteApiKey(item.id);
      setApiKeys((current) => current.filter((key) => key.id !== item.id));
      if (form.id === item.id) setForm(emptyForm);
      setDeleteTarget(null);
      setLoadState("ready");
      setMessage(t(apiText.deleted));
    } catch (error) {
      setLoadState("error");
      setMessage(error.message || t(apiText.deleteFailed));
    } finally {
      setDeletingId("");
    }
  }

  return (
    <div className="api-settings-dashboard">
      <section className="api-settings-panel api-overview-panel">
        <div className="api-overview-head">
          <div>
            <h2>{t(apiText.title)}</h2>
            <p>{t(apiText.description)}</p>
          </div>
          <button className="primary-action compact" type="button" onClick={() => startCreate("llm")}>
            {t(apiText.addKey)}
          </button>
        </div>

        {showInitialLoading ? (
          <PageLoading label={t(apiText.loadingSettings)} />
        ) : (
          <>
            <div className="api-strip-next" aria-label={t(apiText.overviewAria)}>
              {overviewKeys.map((service) => (
                <button className="api-strip-item-next" type="button" onClick={() => startCreate(service.id)} key={service.id}>
                  <span>{localizedText(service.name, language)}</span>
                  <strong>{service.keys.length ? `${service.keys.length} ${t(apiText.keyCount)}` : t(apiText.emptyConfig)}</strong>
                </button>
              ))}
            </div>

            <section className="api-service-grid-next">
              {groupedKeys.map((service) => (
                <section className={`api-column-next${service.id === "draft" ? " api-draft-column-next" : ""}`} key={service.id}>
                  <div className="api-column-head">
                    <h3>{localizedText(service.name, language)}</h3>
                    <p>{localizedText(service.desc, language)}</p>
                  </div>
                  {(                    <div className="api-key-list-next">
                      {service.keys.length ? (
                        service.keys.map((item) => (
                          <ApiKeyCard
                            item={item}
                            serviceName={localizedText(service.name, language)}
                            deleting={deletingId === item.id}
                            onEdit={() => startEdit(item)}
                            onDelete={() => requestDelete(item)}
                            key={item.id}
                          />
                        ))
                      ) : (
                        <article className="empty-api-card-next">{t(apiText.emptyConfig)}</article>
                      )}
                    </div>
                  )}
                </section>
              ))}
            </section>
          </>
        )}
      </section>

      {dialogOpen ? (
        <div className="api-dialog-backdrop" role="presentation">
          <section className="api-key-dialog-next" role="dialog" aria-modal="true" aria-labelledby="api-dialog-title">
            <div className="api-dialog-head">
              <div>
                <h3 id="api-dialog-title">{form.id ? t(apiText.editKey) : t(apiText.addApiKey)}</h3>
              </div>
              <button className="api-dialog-close" type="button" onClick={closeDialog} aria-label={t(apiText.close)}>
                ×
              </button>
            </div>

            <form className="api-key-form" onSubmit={handleSubmit}>
              <label>
                {t(apiText.serviceType)}
                <select value={form.serviceType} onChange={(event) => updateForm("serviceType", event.target.value)}>
                  {serviceTypes.map((service) => (
                    <option value={service.id} key={service.id}>
                      {localizedText(service.name, language)}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                {t(apiText.channel)}
                <select value={form.channel} onChange={(event) => updateForm("channel", event.target.value)}>
                  {!channelOptions.length ? <option value="">暂无可用渠道，请联系站点管理员</option> : null}
                  {channelOptions.map((channel) => (
                    <option value={channel} key={channel}>
                      {formatApiChannelName(channel)}
                    </option>
                  ))}
                </select>
              </label>

              <div className="api-channel-hint">
                {form.channel === "自定义渠道"
                  ? t(apiText.customHint)
                  : language === "en"
                    ? `${t(apiText.selectedChannelPrefix)} ${formatApiChannelName(form.channel)}; ${t(apiText.selectedChannelSuffix)}`
                    : `${t(apiText.selectedChannelPrefix)} ${formatApiChannelName(form.channel)}，${t(apiText.selectedChannelSuffix)}`}
              </div>

              {loadState === "error" || saving ? (
                <div className={`api-dialog-message-next ${loadState === "error" ? "error" : "loading"}`}>
                  {message}
                </div>
              ) : null}

              <label>
                API Key
                <input
                  value={form.apiKey}
                  onChange={(event) => updateForm("apiKey", event.target.value)}
                  placeholder={form.id ? t(apiText.keepOriginalKey) : t(apiText.inputApiKey)}
                  autoComplete="off"
                />
              </label>

              {form.channel === "自定义渠道" ? (
                <div className="custom-api-fields-next">
                  <label>
                    {t(apiText.endpoint)}
                    <input
                      type="url"
                      value={form.endpoint}
                      onChange={(event) => updateForm("endpoint", event.target.value)}
                      placeholder="https://api.example.com/v1"
                      required
                    />
                  </label>
                  <label>
                    {t(apiText.model)}
                    <input value={form.model} onChange={(event) => updateForm("model", event.target.value)} placeholder={t(apiText.modelPlaceholder)} />
                  </label>
                </div>
              ) : null}

              <ApiTeamShareField
                teamContext={teamContext}
                checked={Boolean(form.teamShared)}
                onChange={(checked) => updateForm("teamShared", checked)}
              />

              <div className="api-dialog-actions">
                <button className="secondary-action" type="button" onClick={closeDialog}>
                  {t(apiText.cancel)}
                </button>
                <button className="primary-action compact" type="submit" disabled={saving}>
                  {saving ? t(apiText.saving) : form.id ? t(apiText.saveEdit) : t(apiText.saveKey)}
                </button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {deleteTarget ? (
        <ApiDeleteConfirmDialog
          item={deleteTarget}
          busy={deletingId === deleteTarget.id}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => handleDelete(deleteTarget)}
        />
      ) : null}
    </div>
  );
}

function ApiDeleteConfirmDialog({ item, busy, onCancel, onConfirm }) {
  const { language, t } = useLanguage();
  const label = formatApiChannelName(item.channel) || (language === "en" ? "this" : "这个");
  return (
    <div className="api-dialog-backdrop" role="presentation" onClick={busy ? undefined : onCancel}>
      <section className="api-confirm-dialog-next danger" role="dialog" aria-modal="true" aria-label={t(apiText.deleteTitle)} onClick={(event) => event.stopPropagation()}>
        <div>
          <p className="eyebrow">{t(apiText.confirmEyebrow)}</p>
          <h3>{t(apiText.deleteTitle)}</h3>
          <p>{language === "en" ? `Delete ${label} ${t(apiText.deleteConfirmSuffix)}` : `确定删除 ${label} ${t(apiText.deleteConfirmSuffix)}`}</p>
        </div>
        <div className="api-confirm-actions-next">
          <button className="secondary-action compact" type="button" disabled={busy} onClick={onCancel}>
            {t(apiText.cancel)}
          </button>
          <button className="primary-action compact danger" type="button" disabled={busy} onClick={onConfirm}>
            {busy ? t(apiText.deletingShort) : t(apiText.deleteTitle)}
          </button>
        </div>
      </section>
    </div>
  );
}

function ApiTeamShareField({ teamContext, checked, onChange }) {
  const { t } = useLanguage();

  if (teamContext?.role === "owner") {
    return (
      <label className="api-team-share-check-next">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>
          <strong>{t(apiText.teamShare)}</strong>
          <small>{t(apiText.teamShareHelp)}</small>
        </span>
      </label>
    );
  }
  if (canCreateTeamWithoutTeam(teamContext)) {
    return (
      <label className="api-team-share-check-next disabled">
        <input type="checkbox" checked={false} disabled readOnly />
        <span>
          <strong>{t(apiText.teamShare)}</strong>
          <small>{t(apiText.teamShareDisabledHelp)}</small>
        </span>
      </label>
    );
  }
  return null;
}

function canCreateTeamWithoutTeam(teamContext) {
  return !teamContext?.team && Boolean(teamContext?.canCreateTeam || teamContext?.membershipPlan === "team");
}

function ApiKeyCard({ item, serviceName, deleting, onEdit, onDelete }) {
  const { t } = useLanguage();
  const canManage = item.canManage !== false;
  return (
    <article className="api-key-card-next">
      <div className="api-key-head">
        <div>
          <h4>{formatApiChannelName(item.channel) || t(apiText.apiChannel)}</h4>
        </div>
        {canManage ? (
          <div className="mini-actions-next">
            <button type="button" onClick={onEdit} title={t(apiText.editTitle)}>
              ✎
            </button>
            <button type="button" onClick={onDelete} disabled={deleting} title={t(apiText.deleteKeyTitle)}>
              {deleting ? "..." : t(apiText.deleteShort)}
            </button>
          </div>
        ) : null}
      </div>
      <p>{t(apiText.serviceLabel)}: {serviceName}</p>
      <p>{t(apiText.ownerLabel)}: {item.scope === "team" ? t(apiText.team) : t(apiText.personal)}</p>
      <p>API Key: {item.keyPreview || item.serverKeyPreview || t(apiText.encrypted)}</p>
      <p>{t(apiText.storageLabel)}: {item.storedOnServer ? t(apiText.backendEncrypted) : t(apiText.localDev)}</p>
    </article>
  );
}

function isHttpsEndpoint(value = "") {
  try {
    const endpoint = new URL(String(value || "").trim());
    return endpoint.protocol === "https:" && Boolean(endpoint.hostname);
  } catch {
    return false;
  }
}

function formatApiChannelName(channel = "") {
  const value = String(channel || "").trim();
  return value;
}
