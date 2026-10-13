// Approval dock for 朝堂 mode. In the workbench the same requests are decision cards in the agent pane
// (ChoiceCard), with a one-line notice there for other edicts, so the dock stays out of the way. The
// dock uses the same cards, so 请旨 questions (options, a written answer) can be answered in the court.
import { useStore } from '../store';
import { ChoiceCard } from './ChoiceCard';

export function ApprovalsDock() {
  const aps = useStore((s) => s.approvals.filter((a) => a.status === 'pending'));
  const mode = useStore((s) => s.ui.mode);
  if (!aps.length || mode !== 'court') return null;
  return (
    <div className="approvals-dock" data-testid="approvals-dock">
      {/* not "active": the court uses Esc and the arrow keys for walking */}
      {aps.slice(0, 3).map((a) => <ChoiceCard key={a.id} a={a} active={false} />)}
      {aps.length > 3 && <div className="muted small">另有 {aps.length - 3} 项待批…</div>}
    </div>
  );
}
