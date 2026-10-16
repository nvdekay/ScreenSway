import "./language-toggle.css";

type Language = "en" | "vi";

const OPTIONS: { value: Language; short: string; name: string }[] = [
  { value: "en", short: "EN", name: "English" },
  { value: "vi", short: "VI", name: "Tiếng Việt" },
];

/**
 * The header language control of the landing page and the browser app: both languages
 * side by side, the current one lit. Each site passes its own language state and label.
 */
export function LanguageToggle({ language, onChange, label }: { language: Language; onChange: (language: Language) => void; label: string }) {
  return (
    <div className="lang-toggle" role="group" aria-label={label}>
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          lang={option.value}
          aria-label={option.name}
          title={option.name}
          aria-pressed={language === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.short}
        </button>
      ))}
    </div>
  );
}
