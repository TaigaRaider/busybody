import { IconClose } from "./Icons";

export default function Toast({ toast, onDismiss }) {
  if (!toast) return null;
  return (
    <div className={`toast ${toast.kind === "error" ? "toast-error" : ""}`}>
      <span>{toast.message}</span>
      <button type="button" onClick={onDismiss} aria-label="Dismiss">
        <IconClose size={14} />
      </button>
    </div>
  );
}