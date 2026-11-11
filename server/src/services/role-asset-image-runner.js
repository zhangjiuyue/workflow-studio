import { httpError } from "../http.js";
import { listAssets, saveAsset } from "./asset-store.js";
import { proxyImageGeneration } from "./model-proxy.js";

const roleImageGenerationConcurrency = 2;
const roleImageAutoMinCount = 1;
const roleImageAutoMaxCount = 5;
const defaultRoleImageType = "mosaic-three";
const roleImageTypeOptions = [
  { id: "single", promptSuffix: "单人角色设计图，保持人物核心特征一致，正常清晰人脸" },
  { id: "sketch-three", promptSuffix: "左侧：人物脸部大特写肖像，右侧：全身三视图转面展示，包含正面、侧面、背面" },
  { id: "mosaic-three", promptSuffix: "正面、侧面、背面同屏排列，保持人物核心特征一致，人物脸部打上马赛克，其他部分保持真实摄影" },
  { id: "custom", promptSuffix: "" },
];
const roleImagePromptRequiredSegments = [
  "全身照",
  "无表情",
  "双手下垂",
  "正常清晰人脸",
  "真实摄影",
  "纯灰白色无缝摄影棚背景",
  "背景中没有任何物体或人物",
];
const roleImageDesignVariants = [
  {
    label: "默认造型",
    prompt: "沿用原始穿着描述",
  },
  {
    label: "日常备用造型",
    prompt: "穿着同身份同季节的深灰色简洁外套，内搭浅色上衣，下穿深色长裤，鞋履简洁",
  },
  {
    label: "材质色彩变化",
    prompt: "穿着低饱和色系中长款外套，内搭纯色上衣，下穿中性色长裤，材质更柔和",
  },
  {
    label: "同风格备用造型",
    prompt: "穿着同风格备用套装，外层与下装剪裁合身，整体颜色比默认造型略有变化",
  },
  {
    label: "简洁替换造型",
    prompt: "穿着符合角色身份的简洁替换服装，浅色内搭配深色外层和长裤，整体干净利落",
  },
];

export async function executeRoleAssetImageGenerationJob(user, input = {}, config = {}) {
  const assetId = normalizeId(input.assetId || input.id);
  if (!assetId) throw httpError(400, "缺少角色资产 ID。");

  const currentAsset = await findRoleAsset(user.id, assetId, config);
  if (!currentAsset) throw httpError(404, "角色资产不存在或已被删除。");

  const currentPayload = normalizeObject(currentAsset.payload);
  const settings = normalizeImageSettings({
    imageKeyId: input.imageKeyId || currentPayload.imageKeyId,
    imageModelId: input.imageModelId || currentPayload.imageModelId,
    imageRatio: input.imageRatio || currentPayload.imageRatio,
    imageResolution: input.imageResolution || currentPayload.imageResolution,
    imageFormat: input.imageFormat || currentPayload.imageFormat,
    roleImageDesignCount: input.roleImageDesignCount || currentPayload.roleImageDesignCount,
    roleImageType: input.roleImageType || currentPayload.roleImageType,
    roleImageCustomPrompt: input.roleImageCustomPrompt || currentPayload.roleImageCustomPrompt,
  });
  if (!settings.imageKeyId) throw httpError(400, "缺少绘画渠道，无法生成角色图。");

  const profiles = normalizeRoleProfiles(currentPayload.roleCharacters || currentPayload.roleProfiles || currentPayload.roleProfile);
  if (!profiles.length) throw httpError(400, "角色资产没有可生成图片的角色资料。");

  let workingProfiles = ensureRoleImageTasks(profiles, settings);
  const tasks = collectRoleImageTasks(workingProfiles);
  if (!tasks.length) {
    const saved = await saveRoleImageProgress(user, currentAsset, currentPayload, workingProfiles, config, {
      status: "done",
      jobId: input.jobId,
      message: "",
    });
    return { asset: saved, completed: 0, total: 0, failed: 0 };
  }

  await saveRoleImageProgress(user, currentAsset, currentPayload, workingProfiles, config, {
    status: "running",
    jobId: input.jobId,
    completed: countCompletedImages(workingProfiles),
    failed: countFailedImages(workingProfiles),
    total: countGeneratedImages(workingProfiles),
  });

  let cursor = 0;
  let completedTasks = 0;

  async function runTask(task) {
    const profile = workingProfiles[task.profileIndex];
    const roleImages = Array.isArray(profile.roleImages) ? profile.roleImages : [];
    const imageIndex = roleImages.findIndex((image) => image.id === task.imageId);
    if (imageIndex < 0) return;

    const currentImage = roleImages[imageIndex];
    const prompt = normalizeText(currentImage.prompt || profile.realisticImagePrompt);
    let nextImage;
    if (!prompt) {
      nextImage = {
        ...currentImage,
        status: "error",
        imageError: "角色绘画提示词为空，无法生成角色图。",
        updatedAt: new Date().toISOString(),
      };
    } else {
      const taskModelId = resolveRoleImageModelId(currentImage.imageModelId || settings.imageModelId);
      nextImage = { ...currentImage, status: "running", imageError: "", updatedAt: new Date().toISOString() };
      workingProfiles = replaceRoleImage(workingProfiles, task.profileIndex, task.imageId, nextImage);
      await saveRoleImageProgress(user, currentAsset, currentPayload, workingProfiles, config, {
        status: "running",
        jobId: input.jobId,
        completed: countCompletedImages(workingProfiles),
        failed: countFailedImages(workingProfiles),
        total: countGeneratedImages(workingProfiles),
      });

      try {
        const result = await proxyImageGeneration({
          apiKeyId: currentImage.imageKeyId || settings.imageKeyId,
          modelId: taskModelId,
          prompt,
          ratio: currentImage.imageRatio || settings.imageRatio,
          resolution: currentImage.imageResolution || settings.imageResolution,
          format: currentImage.imageFormat || settings.imageFormat,
          count: 1,
          taskType: "asset-role-image",
        }, config, user);
        const imageObject = firstImageObject(result);
        if (!imageObject.imageUrl) throw new Error("角色图片生成完成，但没有返回可显示图片。");
        nextImage = {
          ...currentImage,
          prompt,
          imageUrl: imageObject.imageUrl,
          thumbnailUrl: imageObject.thumbnailUrl,
          imageError: "",
          status: "done",
          imageKeyId: currentImage.imageKeyId || settings.imageKeyId,
          imageModelId: taskModelId,
          imageRatio: currentImage.imageRatio || settings.imageRatio,
          imageResolution: currentImage.imageResolution || settings.imageResolution,
          imageFormat: currentImage.imageFormat || settings.imageFormat,
          updatedAt: new Date().toISOString(),
        };
      } catch (error) {
        nextImage = {
          ...currentImage,
          prompt,
          imageUrl: "",
          thumbnailUrl: "",
          imageError: error.message || "角色图片生成失败。",
          status: "error",
          imageKeyId: currentImage.imageKeyId || settings.imageKeyId,
          imageModelId: taskModelId,
          imageRatio: currentImage.imageRatio || settings.imageRatio,
          imageResolution: currentImage.imageResolution || settings.imageResolution,
          imageFormat: currentImage.imageFormat || settings.imageFormat,
          updatedAt: new Date().toISOString(),
        };
      }
    }

    completedTasks += 1;
    workingProfiles = replaceRoleImage(workingProfiles, task.profileIndex, task.imageId, nextImage);
    await saveRoleImageProgress(user, currentAsset, currentPayload, workingProfiles, config, {
      status: "running",
      jobId: input.jobId,
      completed: countCompletedImages(workingProfiles),
      failed: countFailedImages(workingProfiles),
      total: countGeneratedImages(workingProfiles),
      progress: Math.round((completedTasks / tasks.length) * 100),
    });
  }

  await Promise.all(Array.from({ length: Math.min(roleImageGenerationConcurrency, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const task = tasks[cursor];
      cursor += 1;
      await runTask(task);
    }
  }));

  const failed = countFailedImages(workingProfiles);
  const completed = countCompletedImages(workingProfiles);
  const total = countGeneratedImages(workingProfiles);
  const finalStatus = failed && completed ? "partial" : failed ? "error" : "done";
  const saved = await saveRoleImageProgress(user, currentAsset, currentPayload, workingProfiles, config, {
    status: finalStatus,
    jobId: input.jobId,
    completed,
    failed,
    total,
    message: failed ? `${failed} 张角色图生成失败。` : "",
  });
  return { asset: saved, completed, total, failed };
}

export async function markRoleAssetImageGenerationError(user, input = {}, config = {}, message = "") {
  const assetId = normalizeId(input.assetId || input.id);
  if (!assetId) return null;
  const currentAsset = await findRoleAsset(user.id, assetId, config).catch(() => null);
  if (!currentAsset) return null;
  const currentPayload = normalizeObject(currentAsset.payload);
  const profiles = normalizeRoleProfiles(currentPayload.roleCharacters || currentPayload.roleProfiles || currentPayload.roleProfile);
  const nextProfiles = profiles.map((profile) => ({
    ...profile,
    roleImages: (Array.isArray(profile.roleImages) ? profile.roleImages : []).map((image) => (
      image.source !== "manual" && !image.imageUrl && ["pending", "running"].includes(image.status)
        ? { ...image, status: "error", imageError: message || "角色图片生成失败。", updatedAt: new Date().toISOString() }
        : image
    )),
  }));
  return await saveRoleImageProgress(user, currentAsset, currentPayload, nextProfiles, config, {
    status: countCompletedImages(nextProfiles) ? "partial" : "error",
    jobId: input.jobId,
    completed: countCompletedImages(nextProfiles),
    failed: countFailedImages(nextProfiles),
    total: countGeneratedImages(nextProfiles),
    message: message || "角色图片生成失败。",
  });
}

async function findRoleAsset(userId, assetId, config) {
  const data = await listAssets(userId, "role", config);
  return (Array.isArray(data.assets) ? data.assets : []).find((asset) => asset.id === assetId) || null;
}

async function saveRoleImageProgress(user, currentAsset, currentPayload, profiles, config, progress = {}) {
  const now = new Date().toISOString();
  const normalizedProfiles = normalizeRoleProfiles(profiles);
  const imageTotal = progress.total ?? countGeneratedImages(normalizedProfiles);
  const imageCompleted = progress.completed ?? countCompletedImages(normalizedProfiles);
  const imageFailed = progress.failed ?? countFailedImages(normalizedProfiles);
  const status = normalizeImageGenerationStatus(progress.status || currentPayload.imageGenerationStatus || "running");
  const desc = status === "running"
    ? `已提取 ${normalizedProfiles.length} 个角色 · 角色图生成中 ${imageCompleted}/${imageTotal}`
    : `已提取 ${normalizedProfiles.length} 个角色`;
  return await saveAsset(user, "role", {
    id: currentAsset.id,
    name: currentAsset.name || currentPayload.name || normalizedProfiles[0]?.name || "角色资产",
    groupId: currentAsset.groupId || currentPayload.groupId || "",
    fileUrl: currentAsset.fileUrl || currentPayload.sourceFile?.fileUrl || "",
    fileKey: currentAsset.fileKey || currentPayload.sourceFile?.fileKey || "",
    mimeType: currentAsset.mimeType || currentPayload.sourceFile?.mimeType || "",
    sizeBytes: currentAsset.sizeBytes || currentPayload.sourceFile?.sizeBytes || 0,
    createdAt: currentAsset.createdAt || currentPayload.createdAt || now,
    payload: {
      ...currentPayload,
      type: "role",
      id: currentAsset.id,
      groupId: currentAsset.groupId || currentPayload.groupId || "",
      name: currentAsset.name || currentPayload.name || normalizedProfiles[0]?.name || "角色资产",
      desc,
      prompt: buildRoleProfilesAnalysisText(normalizedProfiles),
      roleProfile: normalizedProfiles[0] || undefined,
      roleCharacters: normalizedProfiles,
      analysisStatus: "done",
      analysisError: "",
      imageGenerationStatus: status,
      imageGenerationError: progress.message || "",
      imageGenerationJobId: normalizeText(progress.jobId || currentPayload.imageGenerationJobId),
      imageGenerationStartedAt: currentPayload.imageGenerationStartedAt || now,
      imageGenerationCompletedAt: ["done", "partial", "error"].includes(status) ? now : "",
      imageGenerationTotal: imageTotal,
      imageGenerationCompleted: imageCompleted,
      imageGenerationFailed: imageFailed,
      updatedAt: now,
    },
  }, config);
}

function ensureRoleImageTasks(profiles, settings) {
  return profiles.map((profile) => {
    const promptItems = roleImageDesignPromptItems(profile, settings.roleImageDesignCount, settings.roleImageType, settings.roleImageCustomPrompt);
    const rawImages = Array.isArray(profile.roleImages) ? profile.roleImages : [];
    const generatedImages = rawImages.filter((image) => image?.source !== "manual");
    const generatedPrompts = generatedImages.map((image) => normalizeText(image?.prompt)).filter(Boolean);
    const hasDuplicateGeneratedPrompts = generatedPrompts.length > 1 && new Set(generatedPrompts).size <= 1;
    const normalizedImages = rawImages.map((image, index) => {
      const promptItem = promptItems[index] || roleImageDesignPromptItem(profile, index, settings.roleImageType, settings.roleImageCustomPrompt);
      const shouldRefreshPrompt = image?.source !== "manual" && !image?.imageUrl && (
        !normalizeText(image?.prompt) ||
        hasDuplicateGeneratedPrompts ||
        isStructuredRoleImagePrompt(image?.prompt)
      );
      return normalizeRoleImageItem({
        ...image,
        variantLabel: image.variantLabel || promptItem.variantLabel,
        variantPrompt: image.variantPrompt || promptItem.variantPrompt,
        prompt: shouldRefreshPrompt ? promptItem.prompt : image.prompt,
        imageKeyId: image.imageKeyId || settings.imageKeyId,
        imageModelId: image.imageModelId || settings.imageModelId,
        imageRatio: image.imageRatio || settings.imageRatio,
        imageResolution: image.imageResolution || settings.imageResolution,
        imageFormat: image.imageFormat || settings.imageFormat,
      }, index, promptItem.prompt);
    });
    const generatedCount = normalizedImages.filter((image) => image.source !== "manual").length;
    const missingCount = Math.max(0, settings.roleImageDesignCount - generatedCount);
    const appendedImages = Array.from({ length: missingCount }, (_, offset) => {
      const designIndex = generatedCount + offset;
      const promptItem = promptItems[designIndex] || roleImageDesignPromptItem(profile, designIndex, settings.roleImageType, settings.roleImageCustomPrompt);
      return normalizeRoleImageItem({
        id: `role-image-${Date.now()}-${designIndex + 1}`,
        source: "generated",
        designIndex: designIndex + 1,
        variantLabel: promptItem.variantLabel,
        variantPrompt: promptItem.variantPrompt,
        prompt: promptItem.prompt,
        status: "pending",
        imageKeyId: settings.imageKeyId,
        imageModelId: settings.imageModelId,
        imageRatio: settings.imageRatio,
        imageResolution: settings.imageResolution,
        imageFormat: settings.imageFormat,
        isDefault: !normalizedImages.length && designIndex === 0,
      }, designIndex, promptItem.prompt);
    });
    return {
      ...profile,
      roleImages: [...normalizedImages, ...appendedImages],
    };
  });
}

function collectRoleImageTasks(profiles) {
  return profiles.flatMap((profile, profileIndex) => (
    (Array.isArray(profile.roleImages) ? profile.roleImages : [])
      .filter((image) => image.source !== "manual" && !image.imageUrl && ["pending", "running", "error"].includes(image.status))
      .map((image) => ({ profileIndex, imageId: image.id }))
  ));
}

function replaceRoleImage(profiles, profileIndex, imageId, nextImage) {
  return profiles.map((profile, index) => {
    if (index !== profileIndex) return profile;
    const roleImages = (Array.isArray(profile.roleImages) ? profile.roleImages : []).map((image) => (
      image.id === imageId ? nextImage : image
    ));
    const defaultImageId = profile.defaultImageId || roleImages.find((image) => image.isDefault)?.id || roleImages[0]?.id || "";
    return normalizeRoleProfileFields({
      ...profile,
      roleImages: roleImages.map((image) => ({ ...image, isDefault: Boolean(defaultImageId && image.id === defaultImageId) })),
      defaultImageId,
    }, profile.name);
  });
}

function firstImageObject(result = {}) {
  const item = Array.isArray(result.imageObjects) ? result.imageObjects[0] : null;
  const fallback = Array.isArray(result.images) ? result.images.find(Boolean) : "";
  return {
    imageUrl: normalizeText(item?.url || item?.imageUrl || item?.fileUrl || fallback),
    thumbnailUrl: normalizeText(item?.thumbnailUrl || item?.imageThumbnailUrl || ""),
  };
}

function normalizeRoleProfiles(value) {
  const items = Array.isArray(value) ? value : value ? [value] : [];
  return items.map((profile, index) => normalizeRoleProfileFields(profile, `角色${index + 1}`)).filter((profile) => (
    profile.name || profile.traits || profile.realisticImagePrompt || (Array.isArray(profile.roleImages) && profile.roleImages.length)
  ));
}

function normalizeRoleProfileFields(profile = {}, fallbackName = "") {
  const fields = normalizeObject(profile);
  const realisticImagePrompt = normalizeText(fields.realisticImagePrompt || fields.realistic_image_prompt || fields.imagePrompt || fields.image_prompt || fields["角色绘画提示词"] || fields["绘画提示词"]);
  const roleImages = normalizeRoleImageItems(fields, realisticImagePrompt);
  const defaultImageId = normalizeText(fields.defaultImageId || fields.defaultRoleImageId || fields.roleImageId)
    || roleImages.find((image) => image.isDefault)?.id
    || roleImages[0]?.id
    || "";
  return {
    ...fields,
    name: normalizeText(fields.name || fields.roleName || fields.role_name || fields.characterName || fields.character_name || fields["角色名字"] || fields["角色名称"] || fallbackName),
    traits: normalizeText(fields.traits || fields.definition || fields.desc || fields.description || fields["角色定义"] || fields["角色特征"] || fields["角色描述"]),
    realisticImagePrompt,
    roleImages: roleImages.map((image) => ({ ...image, isDefault: Boolean(defaultImageId && image.id === defaultImageId) || image.isDefault })),
    defaultImageId,
  };
}

function normalizeRoleImageItems(fields = {}, fallbackPrompt = "") {
  const rawItems = Array.isArray(fields.roleImages)
    ? fields.roleImages
    : Array.isArray(fields.images)
      ? fields.images
      : [];
  const items = rawItems.map((item, index) => normalizeRoleImageItem(item, index, fallbackPrompt));
  if (!items.length && (fields.imageUrl || fields.thumbnailUrl || fields.imageError)) {
    items.push(normalizeRoleImageItem({
      source: "generated",
      prompt: fallbackPrompt,
      imageUrl: fields.imageUrl,
      thumbnailUrl: fields.thumbnailUrl,
      imageError: fields.imageError,
      status: fields.imageError ? "error" : fields.imageUrl ? "done" : "pending",
      isDefault: true,
    }, 0, fallbackPrompt));
  }
  return items;
}

function normalizeRoleImageItem(item = {}, index = 0, fallbackPrompt = "") {
  const source = item.source === "manual" ? "manual" : "generated";
  const imageUrl = normalizeText(item.imageUrl || item.image_url || item.url || item.fileUrl);
  const imageError = normalizeText(item.imageError || item.image_error);
  return {
    id: normalizeId(item.id || item.imageId || item.roleImageId) || `role-image-${Date.now()}-${index + 1}`,
    source,
    designIndex: Math.max(1, Number(item.designIndex || item.index || index + 1)),
    variantLabel: normalizeText(item.variantLabel || item.variantName),
    variantPrompt: normalizeText(item.variantPrompt || item.variant),
    prompt: source === "manual"
      ? normalizeText(item.prompt)
      : normalizeGeneratedRoleImagePrompt(item.prompt || item.realisticImagePrompt || item.imagePrompt || fallbackPrompt, index, fallbackPrompt),
    note: normalizeText(item.note || item.desc || item.description),
    imageUrl,
    thumbnailUrl: normalizeText(item.thumbnailUrl || item.thumbnail_url || item.imageThumbnailUrl || item.thumbUrl),
    imageError,
    status: normalizeText(item.status) || (imageError ? "error" : imageUrl ? "done" : "pending"),
    imageKeyId: normalizeId(item.imageKeyId || item.apiKeyId),
    imageModelId: normalizeText(item.imageModelId || item.modelId),
    imageRatio: normalizeText(item.imageRatio || item.ratio),
    imageResolution: normalizeText(item.imageResolution || item.resolution),
    imageFormat: normalizeText(item.imageFormat || item.format),
    createdAt: normalizeText(item.createdAt),
    updatedAt: normalizeText(item.updatedAt),
    isDefault: Boolean(item.isDefault || item.default),
  };
}

function normalizeImageSettings(settings = {}) {
  const rawModelId = normalizeText(settings.imageModelId || "gemini-3.1-flash-image-preview");
  return {
    imageKeyId: normalizeId(settings.imageKeyId),
    imageModelId: resolveRoleImageModelId(rawModelId),
    imageRatio: normalizeText(settings.imageRatio || "1:1"),
    imageResolution: normalizeText(settings.imageResolution || "1k"),
    imageFormat: normalizeText(settings.imageFormat || "png"),
    roleImageDesignCount: clampRoleImageDesignCount(settings.roleImageDesignCount || 1),
    roleImageType: normalizeRoleImageType(settings.roleImageType),
    roleImageCustomPrompt: normalizeText(settings.roleImageCustomPrompt),
  };
}

function roleImageDesignPromptItems(profile = {}, count = 1, roleImageType = defaultRoleImageType, roleImageCustomPrompt = "") {
  return Array.from({ length: clampRoleImageDesignCount(count) }, (_, index) => roleImageDesignPromptItem(profile, index, roleImageType, roleImageCustomPrompt));
}

function roleImageDesignPromptItem(profile = {}, index = 0, roleImageType = defaultRoleImageType, roleImageCustomPrompt = "") {
  const normalizedType = normalizeRoleImageType(roleImageType);
  const variant = roleImageDesignVariant(index);
  const prompt = composeRoleImageGenerationPrompt(profile.realisticImagePrompt || profile.imagePrompt || profile.prompt, index, normalizedType, roleImageCustomPrompt);
  return {
    variantLabel: variant.label,
    variantPrompt: variant.prompt,
    prompt,
  };
}

export function composeRoleImageGenerationPrompt(basePrompt = "", index = 0, roleImageType = defaultRoleImageType, roleImageCustomPrompt = "") {
  const normalizedType = normalizeRoleImageType(roleImageType);
  const baseParts = splitPromptParts(normalizeText(basePrompt));
  const identityParts = roleImageIdentityPartsFromPromptParts(baseParts);
  const originalOutfitParts = roleImageOutfitPartsFromPromptParts(baseParts);
  const outfitPrompt = roleImageOutfitPromptForVariant(index, originalOutfitParts, identityParts);
  const styleParts = roleImageStylePartsForType(normalizedType, roleImageCustomPrompt);
  return uniquePromptParts([...identityParts, outfitPrompt, ...styleParts]).join("，");
}

function roleImageIdentityPartsFromPromptParts(parts = []) {
  return uniquePromptParts(parts.filter((part) => (
    !isRoleImageStylePart(part) &&
    !isRoleImageOutfitPart(part)
  )));
}

function roleImageOutfitPartsFromPromptParts(parts = []) {
  return uniquePromptParts(parts.filter((part) => (
    !isRoleImageStylePart(part) &&
    isRoleImageOutfitPart(part)
  )));
}

function roleImageOutfitPromptForVariant(index = 0, originalOutfitParts = [], identityParts = []) {
  const originalOutfit = uniquePromptParts(originalOutfitParts).join("，");
  if (index === 0 && originalOutfit) return originalOutfit;
  const style = roleImageOutfitVariantStyle([...identityParts, originalOutfit].join("，"));
  const variants = roleImageOutfitVariantPrompts(style);
  return variants[Math.max(0, index - 1) % variants.length] || roleImageDesignVariant(index).prompt;
}

function roleImageOutfitVariantStyle(text = "") {
  if (/董事|总裁|经理|老板|商务|职场|助理|秘书|律师|西装|衬衫|领带/.test(text)) return "business";
  if (/农村|朴素|老人|老年|老太|老大爷|老爷爷|老奶奶/.test(text)) return "plain";
  if (/女性|女人|女生|女孩|裙|连衣裙|半身裙/.test(text)) return "soft";
  return "neutral";
}

function roleImageOutfitVariantPrompts(style = "neutral") {
  const variants = {
    business: [
      "穿着深灰色西装外套，内搭浅色衬衫，下穿黑色西裤，鞋履简洁",
      "穿着深蓝色商务外套，内搭中性色上衣，下穿深色长裤，材质更柔和",
      "穿着低饱和色系正式套装，外层与长裤剪裁合身，整体颜色比默认造型略有变化",
      "穿着简洁商务替换服装，浅色内搭配深色外层和长裤，整体干净利落",
    ],
    plain: [
      "穿着朴素灰色外套，内搭浅色上衣，下穿深色直筒长裤，鞋履简洁",
      "穿着低饱和色系日常上衣和长裤，面料自然朴素，整体更柔和",
      "穿着简洁生活感套装，外层与下装颜色略有变化，气质质朴",
      "穿着符合年龄和身份的简洁替换服装，浅色内搭配深色外层和长裤",
    ],
    soft: [
      "穿着米色中长款外套，内搭浅色上衣，下穿深色半身裙，鞋履简洁",
      "穿着低饱和色系柔和套装，内搭纯色上衣，下装颜色更浅，材质更柔和",
      "穿着同风格日常套装，外层与下装剪裁合身，整体颜色比默认造型略有变化",
      "穿着简洁替换服装，浅色内搭配中性色外层和下装，整体干净利落",
    ],
    neutral: [
      "穿着同身份同季节的深灰色简洁外套，内搭浅色上衣，下穿深色长裤，鞋履简洁",
      "穿着低饱和色系中长款外套，内搭纯色上衣，下穿中性色长裤，材质更柔和",
      "穿着同风格备用套装，外层与下装剪裁合身，整体颜色比默认造型略有变化",
      "穿着符合角色身份的简洁替换服装，浅色内搭配深色外层和长裤，整体干净利落",
    ],
  };
  return variants[style] || variants.neutral;
}

function roleImageStylePartsForType(roleImageType = defaultRoleImageType, roleImageCustomPrompt = "") {
  const normalizedType = normalizeRoleImageType(roleImageType);
  const baseSegments = roleImagePromptRequiredSegments.filter((segment) => (
    normalizedType !== "mosaic-three" || !isRoleImageNaturalFacePart(segment)
  ));
  if (normalizedType === "single") {
    return uniquePromptParts([...baseSegments, "正常清晰人脸", "单人角色设计图"]);
  }
  if (normalizedType === "sketch-three") {
    return uniquePromptParts([...baseSegments, "左侧：人物脸部大特写肖像，右侧：全身三视图转面展示，包含正面、侧面、背面"]);
  }
  if (normalizedType === "mosaic-three") {
    return uniquePromptParts([...baseSegments, "人物脸部打上马赛克", "其他部分保持真实摄影", "三视图", "正面、侧面、背面同屏排列"]);
  }
  if (normalizedType === "custom") {
    return uniquePromptParts([...baseSegments, ...splitPromptParts(roleImageCustomPrompt)]);
  }
  return baseSegments;
}

function isRoleImageStylePart(part = "") {
  const text = normalizeText(part);
  return Boolean(
    roleImagePromptRequiredSegments.some((segment) => text.includes(segment)) ||
    isRoleImageFaceMosaicPart(text) ||
    isRoleImageSketchFacePart(text) ||
    isRoleImageHeadshotThreeViewPart(text) ||
    isRoleImageNaturalFacePart(text) ||
    isRoleImageThreeViewPart(text) ||
    /单人角色设计图|素描三视图|正面.*侧面.*背面|横屏|同屏排列|真实摄影|摄影棚背景|背景中没有任何物体或人物|保持人物核心特征一致|其他部分保持真实摄影/.test(text)
  );
}

function isRoleImageOutfitPart(part = "") {
  return /(?:穿着|身穿|内搭|外套|上衣|衬衫|T恤|毛衣|风衣|夹克|西装|套装|连衣裙|半身裙|裙|裤|长裤|短裤|鞋|靴|马甲|领带|高领|卫衣|制服|工装|旗袍|汉服|围裙|披肩|衣服|服装|下穿|上身|下身)/.test(normalizeText(part));
}

function normalizeGeneratedRoleImagePrompt(prompt = "", index = 0, fallbackPrompt = "") {
  const text = normalizeText(prompt);
  if (!text) return normalizeText(fallbackPrompt);
  if (isStructuredRoleImagePrompt(text)) return flattenStructuredRoleImagePrompt(text, index, fallbackPrompt);
  return uniquePromptParts(splitPromptParts(text)).join("，");
}

function isStructuredRoleImagePrompt(prompt = "") {
  return /核心特征固定：|本图差异：|图片类型要求：/.test(normalizeText(prompt));
}

function flattenStructuredRoleImagePrompt(prompt = "", index = 0, fallbackPrompt = "") {
  const corePrompt = extractStructuredRoleImagePromptValue(prompt, "核心特征固定") || fallbackPrompt;
  const typePrompt = extractStructuredRoleImagePromptValue(prompt, "图片类型要求");
  const inferredType = inferRoleImageTypeFromPrompt(typePrompt || prompt);
  return composeRoleImageGenerationPrompt(corePrompt, index, inferredType, inferredType === "custom" ? typePrompt : "");
}

function extractStructuredRoleImagePromptValue(prompt = "", label = "") {
  const text = String(prompt || "");
  const labels = ["核心特征固定", "本图差异", "禁止改变", "图片类型要求"];
  const start = text.indexOf(`${label}：`);
  if (start < 0) return "";
  const valueStart = start + label.length + 1;
  const tail = text.slice(valueStart);
  const nextIndexes = labels
    .filter((item) => item !== label)
    .map((item) => tail.indexOf(`，${item}：`))
    .filter((position) => position >= 0);
  const value = nextIndexes.length ? tail.slice(0, Math.min(...nextIndexes)) : tail;
  return normalizeText(value.replace(/^，+|，+$/g, ""));
}

function inferRoleImageTypeFromPrompt(prompt = "") {
  const text = normalizeText(prompt);
  if (isRoleImageFaceMosaicPart(text)) return "mosaic-three";
  if (isRoleImageHeadshotThreeViewPart(text) || isRoleImageSketchFacePart(text) || text.includes("素描三视图")) return "sketch-three";
  if (text.includes("单人角色设计图")) return "single";
  return defaultRoleImageType;
}

function roleImageDesignVariant(index = 0) {
  return roleImageDesignVariants[index] || {
    label: `备用造型 ${index + 1}`,
    prompt: "穿着符合角色身份的简洁备用服装，整体颜色和材质轻微变化",
  };
}

function clampRoleImageDesignCount(value) {
  return Math.max(roleImageAutoMinCount, Math.min(roleImageAutoMaxCount, Number(value || 1)));
}

function normalizeRoleImageType(value = "") {
  const id = normalizeText(value);
  return roleImageTypeOptions.some((item) => item.id === id) ? id : defaultRoleImageType;
}

function splitPromptParts(prompt = "") {
  return normalizeText(prompt).split(/[，,]/).map((part) => part.trim()).filter(Boolean);
}

function uniquePromptParts(parts = []) {
  const result = [];
  parts.forEach((part) => {
    const text = normalizeText(part);
    if (text && !result.includes(text)) result.push(text);
  });
  return result;
}

function isRoleImageFaceMosaicPart(part = "") {
  const text = normalizeText(part);
  return /(?:脸|人脸|面部|人物脸部).*(?:马赛克|打码|打上马赛克|模糊)|(?:马赛克|打码|模糊).*(?:脸|人脸|面部|人物脸部)/.test(text);
}

function isRoleImageSketchFacePart(part = "") {
  return /(?:脸|人脸|面部|人物脸部).*素描|素描.*(?:脸|人脸|面部|人物脸部)/.test(normalizeText(part));
}

function isRoleImageHeadshotThreeViewPart(part = "") {
  const text = normalizeText(part);
  return /人物脸部大特写肖像|全身三视图转面展示|^包含正面$|^侧面$|^背面$/.test(text);
}

function isRoleImageNaturalFacePart(part = "") {
  return /正常清晰人脸|清晰人脸|真实人脸|不做马赛克/.test(normalizeText(part));
}

function isRoleImageThreeViewPart(part = "") {
  return /三视图|正面.*侧面.*背面|正\/侧\/背/.test(normalizeText(part));
}

function resolveRoleImageModelId(value = "") {
  const modelId = normalizeText(value);
  return modelId;
}

function buildRoleProfilesAnalysisText(profiles = []) {
  const normalized = normalizeRoleProfiles(profiles);
  return JSON.stringify({
    角色数量: normalized.length,
    角色列表: normalized.map((profile) => ({
      角色名字: profile.name,
      角色定义: profile.traits,
      角色绘画提示词: profile.realisticImagePrompt,
    })),
  }, null, 2);
}

function countGeneratedImages(profiles = []) {
  return profiles.reduce((total, profile) => total + (Array.isArray(profile.roleImages) ? profile.roleImages.filter((image) => image.source !== "manual").length : 0), 0);
}

function countCompletedImages(profiles = []) {
  return profiles.reduce((total, profile) => total + (Array.isArray(profile.roleImages) ? profile.roleImages.filter((image) => image.source !== "manual" && image.imageUrl).length : 0), 0);
}

function countFailedImages(profiles = []) {
  return profiles.reduce((total, profile) => total + (Array.isArray(profile.roleImages) ? profile.roleImages.filter((image) => image.source !== "manual" && image.imageError && !image.imageUrl).length : 0), 0);
}

function normalizeImageGenerationStatus(value = "") {
  const status = normalizeText(value);
  return ["running", "done", "partial", "error"].includes(status) ? status : "running";
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeText(value = "") {
  return String(value || "").trim();
}

function normalizeId(value = "") {
  return normalizeText(value);
}
