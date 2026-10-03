// One list of names the agent asks to confirm, shared by applying a draft and
// creating a project.

export function ConfirmList({
  title,
  note,
  entries,
  checked,
  onToggle,
  testId
}: {
  title: string;
  note?: string;
  entries: readonly string[];
  checked: ReadonlySet<string>;
  onToggle: (value: string) => void;
  testId: string;
}) {
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[13px] font-medium">{title}</p>
      {note ? <p className="text-[12px] text-muted-foreground">{note}</p> : null}
      {entries.map((entry) => (
        <label key={entry} className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            data-testid={`${testId}-${entry}`}
            checked={checked.has(entry)}
            onChange={() => onToggle(entry)}
          />
          <span className="font-mono text-[12.5px]">{entry}</span>
        </label>
      ))}
    </div>
  );
}
