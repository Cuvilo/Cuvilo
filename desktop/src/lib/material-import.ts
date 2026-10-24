export function materialDropError(paths: string[]): string | null {
  if (!paths.length) return "请选择材料文件。";
  if (paths.length === 1 && !/\.(pdf|docx|txt|md)$/i.test(paths[0])) return "支持 PDF、DOCX、TXT 和 Markdown 文件。";
  return null;
}
