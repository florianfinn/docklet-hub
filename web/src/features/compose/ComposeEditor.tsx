import { useTranslations } from "use-intl";
import { EditorShell } from "../../platform/editor/EditorShell";
import { composeEditorAdapter } from "./editor-adapter";
export type ComposeEditorProps = { value: string; onChange: (value: string) => void; disabled?: boolean };
export function ComposeEditor({ value, onChange, disabled = false }: ComposeEditorProps) {
  const t = useTranslations();
  return <EditorShell value={value} onChange={onChange} adapter={composeEditorAdapter}
    label={t("composeEditLabel")} testId="compose-editor" disabled={disabled} />;
}
