import { Directory, File, Paths } from "expo-file-system";
import { StorageAccessFramework } from "expo-file-system/legacy";
import { Platform, Share } from "react-native";

export async function saveAccountExport(download: () => Promise<string>): Promise<boolean> {
  const now = new Date();
  const date = now.toLocaleDateString("sv-SE");
  const basename = `011120-导出-${date}`;
  const filename = `${basename}.json`;

  if (Platform.OS === "android") {
    const directory = await StorageAccessFramework.requestDirectoryPermissionsAsync();
    if (!directory.granted) return false;
    const body = await download();
    const uri = await StorageAccessFramework.createFileAsync(directory.directoryUri, basename, "application/json");
    await StorageAccessFramework.writeAsStringAsync(uri, body);
    return true;
  }

  const body = await download();
  if (Platform.OS === "web") {
    const uri = URL.createObjectURL(new Blob([body], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = uri;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(uri), 1000);
    return true;
  }

  const directory = new Directory(Paths.cache, `account-export-${now.getTime()}`);
  directory.create();
  try {
    const file = new File(directory, filename);
    file.write(body);
    const result = await Share.share({ url: file.uri });
    return result.action === Share.sharedAction;
  } finally {
    directory.delete();
  }
}
