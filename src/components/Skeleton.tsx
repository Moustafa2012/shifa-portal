import { Skeleton as ShadcnSkeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Loading placeholders rebuilt using shadcn/ui Skeleton primitives.
 * Shaped like the content they stand in for to prevent layout shifts.
 */
const S = ({
  className = "",
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) => <ShadcnSkeleton className={cn("skeleton", className)} style={style} />;

function Frame({ children, label }: { children: React.ReactNode; label?: string }) {
  return <div role="status" aria-busy="true" aria-label={label ?? "loading"} className="stack">{children}</div>;
}

export const SkelHead = () => (
  <div><S className="sk-title" /><S className="sk-line" style={{ width: "58%" }} /></div>
);
export const SkelTiles = ({ n = 3 }: { n?: number }) => (
  <div className="grid cols-3">{Array.from({ length: n }, (_, i) => <S key={i} className="sk-tile" />)}</div>
);
export const SkelCards = ({ n = 2 }: { n?: number }) => (
  <div className="grid cols-2">{Array.from({ length: n }, (_, i) => <S key={i} className="sk-card" />)}</div>
);
export const SkelRows = ({ n = 5 }: { n?: number }) => (
  <div className="card stack" style={{ gap: ".6rem" }}>
    {Array.from({ length: n }, (_, i) => (
      <div key={i} className="row" style={{ flexWrap: "nowrap" }}>
        <S className="sk-dot" /><div style={{ flex: 1 }}><S className="sk-line" style={{ width: `${55 + ((i * 17) % 35)}%` }} /><S className="sk-line sm" style={{ width: `${30 + ((i * 11) % 25)}%` }} /></div>
      </div>
    ))}
  </div>
);
export const SkelChart = () => <div className="card"><S className="sk-line" style={{ width: "30%" }} /><S className="sk-chart" /></div>;

export const SkelOverview = () => <Frame><SkelHead /><SkelTiles n={3} /><SkelTiles n={3} /><SkelCards /><SkelRows n={4} /></Frame>;
export const SkelList = () => <Frame><SkelHead /><SkelRows n={5} /></Frame>;
export const SkelVitals = () => <Frame><SkelHead /><SkelTiles n={3} /><SkelChart /><SkelRows n={4} /></Frame>;
export const SkelPatients = () => (
  <Frame>
    <SkelHead />
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
      {Array.from({ length: 4 }, (_, i) => (
        <S key={i} className="sk-card" style={{ height: 90, borderRadius: 12 }} />
      ))}
    </div>
    <S className="sk-card mb-6" style={{ height: 80, borderRadius: 12 }} />
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
      {Array.from({ length: 6 }, (_, i) => (
        <S key={i} className="sk-card" style={{ height: 210, borderRadius: 12 }} />
      ))}
    </div>
  </Frame>
);
export const SkelForm = () => <Frame><SkelHead /><div className="card stack"><S className="sk-input" /><S className="sk-input" /><S className="sk-input" /></div></Frame>;
