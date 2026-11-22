export type Stage1MediaPresentation =
  | { kind: "IMAGE"; url: string; alt?: string }
  | { kind: "UNAVAILABLE"; label: string };

export function toStage1MediaPresentation(media: Record<string, unknown>): Stage1MediaPresentation {
  const type = typeof media.type === "string" ? media.type.toUpperCase() : "";
  const rawUrl = typeof media.url === "string" ? media.url : undefined;
  const safeUrl = rawUrl && /^https?:\/\//i.test(rawUrl) ? rawUrl : undefined;
  const alt = typeof media.alt === "string" ? media.alt : undefined;

  if (type === "IMAGE" && safeUrl) {
    return {
      kind: "IMAGE",
      url: safeUrl,
      ...(alt ? { alt } : {}),
    };
  }

  if (type === "VIDEO") {
    return { kind: "UNAVAILABLE", label: "视频暂时不能在这里播放。" };
  }

  return { kind: "UNAVAILABLE", label: "这段媒体暂时打不开。" };
}
