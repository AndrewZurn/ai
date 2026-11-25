const identity = "run_[a-f0-9]{32}-html_[a-f0-9]{32}\\.html";
const generated = new RegExp(`^\\.swarms/(?:${identity}|\\.${identity}\\.tmp-[a-f0-9]{32})$`);
const temporary = new RegExp(`^\\.swarms/\\.${identity}\\.tmp-[a-f0-9]{32}$`);

// Naming only: a matching name is not proof of plugin ownership. Fingerprint
// exclusions additionally require the controller's durable provenance record.
export const isReportArtifact = file => generated.test(file);
export const isTemporaryReportArtifact = file => temporary.test(file);

export function reportFilename(run) {
  const filename = `${run.id}-${run.reportRequest.id}.html`;
  if (!isReportArtifact(`.swarms/${filename}`)) throw new Error("Invalid report identity.");
  return filename;
}
