// Native user messages contain resolved base64 files; prompt admission takes
// URIs. Forward the resolved bytes natively, not as base64 inside task prose.
// Mentions refer to offsets in the original text and must not be reused.
export function files(input = []) {
  return input.map(file => ({
    uri: file.uri ?? `data:${file.mime};base64,${file.data}`,
    ...(file.name ? { name: file.name } : {}),
    ...(file.description ? { description: file.description } : {}),
  }));
}

export function skills(input = []) {
  return input.map(skill => ({ id: skill.id }));
}

export function uniqueFiles(input) {
  return [...new Map(input.map(file => [file.uri, file])).values()];
}

export function uniqueSkills(input) {
  return [...new Map(input.map(skill => [skill.id, skill])).values()];
}
