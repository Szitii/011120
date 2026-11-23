import type { ConfigContext } from "expo/config";

export default function appConfig({ config }: ConfigContext) {
  if (process.env.NODE_ENV === "production" || process.env.EAS_BUILD === "true") {
    if (process.env.EXPO_PUBLIC_OWNER_BEARER_TOKEN !== undefined) {
      throw new Error("Remove EXPO_PUBLIC_OWNER_BEARER_TOKEN before building a release.");
    }
    const mode = process.env.EXPO_PUBLIC_DATA_MODE;
    if (mode !== undefined && mode !== "real") {
      throw new Error("Release builds require EXPO_PUBLIC_DATA_MODE=real.");
    }
  }
  return config;
}
