export function workflowAudioProgressView(progress) {
  const source = progress && typeof progress === "object" ? progress : {};
  const totalChunks = nonNegativeInteger(source.totalChunks);
  const completedChunks = Math.min(nonNegativeInteger(source.completedChunks), totalChunks);

  if (!totalChunks) {
    return {
      determinate: false,
      totalChunks: 0,
      completedChunks: 0,
      currentChunk: 0,
      percentage: 0,
      title: "音频生成中",
      detail: "正在生成口播音频并提取时间戳。",
    };
  }

  const finalizing = completedChunks >= totalChunks;
  const requestedCurrentChunk = nonNegativeInteger(source.currentChunk);
  const currentChunk = finalizing
    ? totalChunks
    : Math.min(totalChunks, Math.max(completedChunks + 1, requestedCurrentChunk || 1));
  const percentage = Math.min(100, Math.round((completedChunks / totalChunks) * 100));

  return {
    determinate: true,
    totalChunks,
    completedChunks,
    currentChunk,
    percentage,
    title: finalizing
      ? `全部 ${totalChunks} 段已生成，正在整理结果`
      : `正在生成第 ${currentChunk}/${totalChunks} 段音频`,
    detail: finalizing
      ? "正在合并音频并保存时间戳，请稍候。"
      : `已完成 ${completedChunks}/${totalChunks} 段，当前段正在生成音频并提取时间戳。`,
  };
}

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}
