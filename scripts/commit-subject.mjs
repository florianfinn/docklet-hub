export const CONVENTIONAL=/^(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\([a-z0-9/-]+\))?!?: .+/;
const MERGE_SUBJECT=/^Merge (?:pull request #\d+ from |branch '|remote-tracking branch ')/;

// Conventional Commit subject; merge commits with two parents keep the subject
// Git or GitHub gives them.
export function subjectAccepted(subject,parentCount=1) {
  return CONVENTIONAL.test(subject) || (parentCount>1 && MERGE_SUBJECT.test(subject));
}
