// A faint lineage tree behind the composer: an old claim branching through the years,
// with one debunk travelling down a branch. Pure decoration; hidden from assistive tech.

const NODES: [number, number, boolean?][] = [
  [90, 300], [250, 220], [250, 380], [420, 160], [430, 290, true], [600, 110], [610, 250, true],
  [620, 420], [790, 200, true], [800, 340], [960, 150], [980, 270, true], [1110, 230, true],
];
// child -> parent edges as index pairs; "hot" edges are the ones a debunk travels.
const EDGES: [number, number, boolean?][] = [
  [1, 0], [2, 0], [3, 1], [4, 1, true], [5, 3], [6, 4, true], [7, 2], [8, 6, true], [9, 6], [10, 8], [11, 8, true], [12, 11, true],
];

function curve(a: [number, number], b: [number, number]) {
  const mx = (a[0] + b[0]) / 2;
  return `M ${b[0]} ${b[1]} C ${mx} ${b[1]}, ${mx} ${a[1]}, ${a[0]} ${a[1]}`;
}

// The debunk's route, oldest to newest: node indices along the hot edges.
const HOT_CHAIN = [1, 4, 6, 8, 11, 12];

export function AmbientTree() {
  const route = HOT_CHAIN.map((n, i) => {
    const [x, y] = NODES[n];
    if (i === 0) return `M ${x} ${y}`;
    const [px, py] = NODES[HOT_CHAIN[i - 1]];
    const mx = (px + x) / 2;
    return `C ${mx} ${py}, ${mx} ${y}, ${x} ${y}`;
  }).join(" ");

  return (
    <svg className="ambient" viewBox="0 0 1180 520" aria-hidden>
      {EDGES.map(([c, p, h], i) => (
        <path
          key={i}
          pathLength={1}
          className={h ? "hot" : undefined}
          style={{ ["--d" as string]: `${200 + NODES[p][0] * 1.4}ms` }}
          d={curve([NODES[c][0], NODES[c][1]], [NODES[p][0], NODES[p][1]])}
        />
      ))}
      {NODES.map(([x, y, h], i) => (
        <circle key={i} cx={x} cy={y} r={h ? 5 : 4} className={h ? "hot" : undefined} style={{ ["--d" as string]: `${x * 1.4}ms` }} />
      ))}
      <circle className="spark" r="3.5" opacity="0">
        <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.08;0.92;1" dur="5s" begin="2.6s" repeatCount="indefinite" />
        <animateMotion dur="5s" begin="2.6s" repeatCount="indefinite" path={route} />
      </circle>
    </svg>
  );
}
