import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "./components/ui/input";
import { TooltipHint } from "./components/ui/tooltip";
import { Button } from "./components/ui/button";
export function SecretInput({
  id,
  label,
  value,
  placeholder,
  onChange,
}: {
  id?: string;
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const [visible, setVisible] = useState(false);
  const toggleLabel = visible ? "隐藏密钥" : "显示密钥";
  return (
    <div className="relative flex w-full items-center">
      <Input
        id={id}
        aria-label={label}
        type={visible ? "text" : "password"}
        className="pr-11"
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      <TooltipHint label={toggleLabel}><Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="absolute right-0.5 size-8 text-muted-foreground"
        aria-label={toggleLabel}
        aria-pressed={visible}
        onClick={() => setVisible((old) => !old)}
      >
        {visible ? <EyeOff size={16} /> : <Eye size={16} />}
      </Button></TooltipHint>
    </div>
  );
}
