export function matchesSensitivePath(
  value: string,
  sensitiveExtensions: readonly string[],
  sensitiveFileNames: readonly string[]
): boolean {
  const fileName = getCrossPlatformBaseName(value);
  if (!fileName) {
    return false;
  }

  const lowerFileName = fileName.toLowerCase();
  const extension = getCrossPlatformExtension(fileName);
  return (
    sensitiveExtensions.some((candidate) => candidate.toLowerCase() === extension) ||
    sensitiveFileNames.some((candidate) => candidate.toLowerCase() === lowerFileName)
  );
}

function getCrossPlatformBaseName(value: string): string {
  const trimmed = value.replace(/[\\/]+$/u, "");
  if (!trimmed) {
    return "";
  }

  const lastSeparatorIndex = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return lastSeparatorIndex >= 0 ? trimmed.slice(lastSeparatorIndex + 1) : trimmed;
}

function getCrossPlatformExtension(fileName: string): string {
  const lastDotIndex = fileName.lastIndexOf(".");
  if (lastDotIndex <= 0) {
    return "";
  }

  return fileName.slice(lastDotIndex).toLowerCase();
}
