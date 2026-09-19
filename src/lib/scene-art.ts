import type { SceneArt } from "../data/scene-catalog.ts";

export type SceneVisual = { art: SceneArt; accent: string; visualSeed: number };

function mountain(x: number, base: number, peak: number, width: number, fill: string) {
  return `<path d="M${x - width} ${base} L${x} ${peak} L${x + width} ${base}Z" fill="${fill}"/>`;
}

function cloud(x: number, y: number, scale = 1, opacity = 0.7) {
  return `<g transform="translate(${x} ${y}) scale(${scale})" fill="#fff" opacity="${opacity}"><ellipse cx="0" cy="0" rx="76" ry="21"/><ellipse cx="-58" cy="8" rx="64" ry="16"/><ellipse cx="58" cy="8" rx="68" ry="17"/></g>`;
}

function tree(x: number, y: number, scale = 1, color = "#58765a") {
  return `<g transform="translate(${x} ${y}) scale(${scale})"><rect x="-4" y="8" width="8" height="48" rx="4" fill="#5d4b37"/><circle cx="0" cy="0" r="34" fill="${color}"/><circle cx="-24" cy="12" r="24" fill="${color}" opacity=".9"/><circle cx="25" cy="12" r="26" fill="${color}" opacity=".86"/></g>`;
}

export function hashString(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function adjustColor(hex: string, seed: number) {
  const value = hex.replace("#", "");
  const shift = (channel: number, offset: number) => Math.max(0, Math.min(255, channel + offset));
  const r = shift(Number.parseInt(value.slice(0, 2), 16), ((seed >> 3) % 25) - 12);
  const g = shift(Number.parseInt(value.slice(2, 4), 16), ((seed >> 7) % 25) - 12);
  const b = shift(Number.parseInt(value.slice(4, 6), 16), ((seed >> 11) % 25) - 12);
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function signatureMotif(seed: number, color: string) {
  const x = 120 + (seed % 850);
  const y = 120 + ((seed >> 5) % 470);
  const scale = 0.75 + ((seed >> 9) % 4) * 0.12;
  const kind = seed % 6;
  const shapes = [
    `<path d="M0 -28 L20 12 H-20Z"/><circle cx="0" cy="-8" r="8"/>`,
    `<circle cx="-20" cy="0" r="18"/><circle cx="18" cy="4" r="14"/><path d="M-35 25 H36"/>`,
    `<path d="M-34 10 Q0 -26 34 10 Q0 34 -34 10Z"/><circle cx="0" cy="8" r="7"/>`,
    `<path d="M0 -34 L28 0 L0 34 L-28 0Z"/><circle cx="0" cy="0" r="7"/>`,
    `<path d="M-38 18 Q0 -22 38 18" fill="none" stroke-width="8"/><circle cx="0" cy="-15" r="10"/>`,
    `<path d="M-30 -16 L30 -16 L18 16 L-18 16Z"/><circle cx="0" cy="-25" r="8"/>`,
  ];
  return `<g transform="translate(${x} ${y}) scale(${scale})" fill="${color}" opacity=".82">${shapes[kind]}</g>`;
}
function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function wrap(name: string, skyTop: string, skyBottom: string, content: string, tone: string) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800" role="img" aria-labelledby="title">
  <title id="title">${escapeXml(name)} scene</title>
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop stop-color="${skyTop}"/><stop offset="1" stop-color="${skyBottom}"/></linearGradient>
    <linearGradient id="deep" x1="0" y1="0" x2="0" y2="1"><stop stop-color="${tone}"/><stop offset="1" stop-color="#1e3b35"/></linearGradient>
    <linearGradient id="water" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#86b5b8"/><stop offset="1" stop-color="#397b82"/></linearGradient>
    <linearGradient id="warm" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#e8b76b"/><stop offset="1" stop-color="#9d5934"/></linearGradient>
    <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency=".8" numOctaves="2" seed="7"/><feColorMatrix values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 .045 0"/></filter>
  </defs>
  <rect width="1200" height="800" fill="url(#sky)"/>
  ${content}
  <rect width="1200" height="800" filter="url(#grain)" opacity=".55"/>
</svg>`;
}
function specialRender(id: string) {
  if (id === "beihai-park") {
    return {
      skyTop: "#e5ece8",
      skyBottom: "#c8d9d3",
      content: `<rect y="560" width="1200" height="240" fill="url(#water)"/><path d="M0 570 Q250 520 500 570 Q760 520 1200 570 L1200 720 L0 720Z" fill="#82a17c"/><path d="M820 580 V280 h28 v300" stroke="#f5f0df" stroke-width="18"/><path d="M800 330 Q834 220 868 330 Q850 380 834 410 Q818 380 800 330Z" fill="#f7f3e7" stroke="#b8b09d" stroke-width="8"/><path d="M800 385 H868" stroke="#b8b09d" stroke-width="8"/>${tree(220, 510, 0.8)}${tree(1050, 520, 0.75)}`,
    };
  }
  if (id === "summer-palace") {
    return {
      skyTop: "#e7e8d8",
      skyBottom: "#c5d4c4",
      content: `<rect y="560" width="1200" height="240" fill="url(#water)"/><path d="M0 500 Q260 430 520 500 Q780 430 1200 500 L1200 610 L0 610Z" fill="#75906e"/><path d="M110 520 Q600 410 1090 520" fill="none" stroke="#d7c79c" stroke-width="54"/><g fill="#8f4637">${Array.from({ length: 9 }, (_, i) => `<path d="M${80 + i * 120} 500 L${145 + i * 120} 455 L${210 + i * 120} 500Z"/>`).join("")}</g><g fill="#efe2c9">${Array.from({ length: 9 }, (_, i) => `<rect x="${90 + i * 120}" y="500" width="110" height="34"/>`).join("")}</g>`,
    };
  }
  if (id === "chengde-resort") {
    return {
      skyTop: "#e6e7d8",
      skyBottom: "#cbd6c6",
      content: `${mountain(180, 560, 320, 180, "#81927f")}${mountain(980, 570, 300, 220, "#718471")}<path d="M0 590 Q300 520 600 590 Q900 520 1200 590 L1200 800 L0 800Z" fill="#66805f"/><rect x="370" y="390" width="460" height="200" fill="#f0e4ce"/><path d="M300 405 L600 260 L900 405Z" fill="#8d4c3e"/><g fill="#8d4c3e">${Array.from({ length: 5 }, (_, i) => `<rect x="${420 + i * 80}" y="365" width="22" height="55" rx="9"/>`).join("")}</g>`,
    };
  }
  if (id === "potala-palace") {
    return {
      skyTop: "#d8e6ee",
      skyBottom: "#e8d8cc",
      content: `<path d="M0 620 Q280 430 600 520 Q900 390 1200 590 L1200 800 L0 800Z" fill="#8a7d68"/><g><rect x="300" y="340" width="600" height="270" fill="#f3efe6" stroke="#8e6b55" stroke-width="8"/><rect x="420" y="260" width="360" height="350" fill="#9f4b43" stroke="#6f4238" stroke-width="8"/><path d="M380 340 H820" stroke="#c49a52" stroke-width="16"/><rect x="500" y="220" width="200" height="60" fill="#d3a24e"/></g>${cloud(240, 380, 0.8, 0.55)}${cloud(980, 360, 0.75, 0.5)}`,
    };
  }
  if (id === "forbidden-city") {
    return {
      skyTop: "#ecd9bb",
      skyBottom: "#d7ad80",
      content: `<rect y="650" width="1200" height="150" fill="#8d5b3d"/><g>${[180, 480, 780].map((x, i) => `<rect x="${x}" y="${390 + i * 20}" width="240" height="${220 - i * 10}" fill="#f0e4ce"/><path d="M${x - 50} ${400 + i * 20} L${x + 120} ${300 + i * 20} L${x + 290} ${400 + i * 20}Z" fill="#a94437"/>`).join("")}</g><path d="M0 720 Q300 680 600 720 Q900 680 1200 720" stroke="#f3e6ca" stroke-width="8" fill="none"/>`,
    };
  }
  if (id === "tiananmen-square") {
    return {
      skyTop: "#e1e5df",
      skyBottom: "#c8d2cd",
      content: `<rect y="610" width="1200" height="190" fill="#9b7654"/><rect x="380" y="350" width="440" height="280" fill="#a84235"/><path d="M320 360 L600 235 L880 360Z" fill="#d68a45"/><rect x="545" y="430" width="110" height="200" fill="#6e342d"/><g fill="#f0d29d">${Array.from({ length: 7 }, (_, i) => `<rect x="${400 + i * 62}" y="320" width="26" height="65" rx="12"/>`).join("")}</g>`,
    };
  }
  if (id === "canton-tower") {
    return {
      skyTop: "#b9d5e1",
      skyBottom: "#e9c38c",
      content: `<g fill="#586b76">${Array.from({ length: 12 }, (_, i) => `<rect x="${40 + i * 95}" y="${480 - (i % 4) * 40}" width="60" height="${250 + (i % 4) * 40}"/>`).join("")}</g><path d="M840 620 L865 180 L885 180 L910 620Z" fill="#6a7b84"/><path d="M850 260 H900 M846 330 H904 M843 400 H907 M840 470 H910" stroke="#f4d49a" stroke-width="8"/><rect y="650" width="1200" height="150" fill="url(#water)"/>`,
    };
  }
  return null;
}
function render(art: SceneArt, accent: string) {
  switch (art) {
    case "wall":
      return {
        skyTop: "#e7e5d5",
        skyBottom: "#c8d4c7",
        content: `${mountain(180, 560, 370, 220, "#859486")} ${mountain(610, 560, 300, 300, "#6c8073")} ${mountain(1000, 570, 390, 250, "#778b79")}<path d="M0 610 Q260 420 520 545 Q760 390 1200 560" fill="none" stroke="#e7dfc9" stroke-width="54"/><path d="M0 610 Q260 420 520 545 Q760 390 1200 560" fill="none" stroke="${accent}" stroke-width="16"/>${cloud(600, 350, 1.2, 0.6)}`,
      };
    case "palace":
      return {
        skyTop: "#ead9bb",
        skyBottom: "#d8b88c",
        content: `<rect y="610" width="1200" height="190" fill="#875b3f"/><g><rect x="220" y="405" width="760" height="210" fill="#efe2ca"/><path d="M160 420 L600 250 L1040 420Z" fill="#a84637"/><path d="M250 405 L600 275 L950 405Z" fill="#6e3c32"/></g><g fill="#a94f3e">${Array.from({ length: 8 }, (_, i) => `<rect x="${275 + i * 85}" y="355" width="28" height="90" rx="14"/>`).join("")}</g><path d="M0 700 Q280 640 600 700 Q920 640 1200 700" fill="none" stroke="#f3e5c8" stroke-width="8"/>`,
      };
    case "garden":
      return {
        skyTop: "#e8eddd",
        skyBottom: "#b8cbb5",
        content: `<rect y="620" width="1200" height="180" fill="url(#water)"/><circle cx="600" cy="390" r="238" fill="#f5f1e4" stroke="#d9d7ca" stroke-width="34"/><circle cx="600" cy="390" r="180" fill="#faf7ec" stroke="#73896f" stroke-width="6"/><path d="M485 485 Q600 335 715 485" fill="#d5dccf" stroke="#536a5f" stroke-width="6"/><rect x="542" y="423" width="116" height="78" fill="#efe7d5" stroke="#536a5f" stroke-width="6"/><path d="M520 425 L600 365 L680 425Z" fill="#5b6f62"/>${tree(230, 470, 0.75)}${tree(1010, 480, 0.8)}`,
      };
    case "architecture":
      return {
        skyTop: "#e6e9df",
        skyBottom: "#c9d2c7",
        content: `<rect y="610" width="1200" height="190" fill="#9a9a83"/><g stroke="#f1eadc" stroke-width="5">${Array.from({ length: 4 }, (_, i) => `<rect x="${120 + i * 270}" y="330" width="210" height="280" fill="${i % 2 ? "#efe6d8" : "#d9c4ae"}"/><path d="M80 330 L225 245 L370 330Z" fill="#a85d4d"/>`).join("")}</g><g fill="#65706b">${Array.from({ length: 12 }, (_, i) => `<rect x="${150 + (i % 4) * 270 + Math.floor(i / 4) * 55}" y="${400 + Math.floor(i / 4) * 58}" width="44" height="58"/>`).join("")}</g>`,
      };
    case "city":
      return {
        skyTop: "#b9d5e0",
        skyBottom: "#edc58b",
        content: `<g fill="#5b6c74">${Array.from({ length: 12 }, (_, i) => `<rect x="${40 + i * 100}" y="${430 - (i % 4) * 45}" width="${65 + (i % 3) * 12}" height="${330 + (i % 4) * 45}"/>`).join("")}</g><path d="M865 600 V260 h18 v340" stroke="#f5e9d6" stroke-width="16"/><circle cx="874" cy="260" r="34" fill="#d96c4a"/><rect y="650" width="1200" height="150" fill="url(#water)"/>`,
      };
    case "coast":
      return {
        skyTop: "#a9d5e2",
        skyBottom: "#f1c58d",
        content: `<circle cx="970" cy="170" r="66" fill="#f6d889"/><rect y="520" width="1200" height="280" fill="url(#water)"/><path d="M0 555 Q260 505 520 555 Q760 505 1200 555 L1200 700 L0 700Z" fill="#e6c27e"/><path d="M170 650 Q210 540 270 530 Q300 600 330 650Z" fill="#496d4e"/><path d="M280 560 Q360 500 430 540" fill="none" stroke="#496d4e" stroke-width="18"/> <path d="M700 560 q40 -18 80 0" stroke="#f4f7f5" stroke-width="6" fill="none"/>`,
      };
    case "ancient-city":
      return {
        skyTop: "#dfe3d3",
        skyBottom: "#c8b898",
        content: `<rect y="590" width="1200" height="210" fill="#8b795f"/><g fill="#efe4ce" stroke="#5f5141" stroke-width="5">${Array.from({ length: 5 }, (_, i) => `<rect x="${60 + i * 230}" y="${360 + (i % 2) * 40}" width="190" height="${220 - (i % 2) * 40}"/><path d="M35 ${360 + (i % 2) * 40} L155 ${295 + (i % 2) * 40} L275 ${360 + (i % 2) * 40}Z" fill="#4e4b43"/>`).join("")}</g><g fill="#c9553d">${Array.from({ length: 6 }, (_, i) => `<circle cx="${110 + i * 190}" cy="${420 + (i % 2) * 40}" r="14"/>`).join("")}</g>`,
      };
    case "grotto":
      return {
        skyTop: "#d7d1b9",
        skyBottom: "#ae9b7e",
        content: `<path d="M0 610 Q180 300 390 220 Q640 160 870 260 Q1040 330 1200 610Z" fill="#9b8068"/><path d="M120 620 Q220 350 400 300 Q610 245 820 335 Q1000 420 1110 620Z" fill="#c0a48a"/>${Array.from({ length: 5 }, (_, i) => `<path d="M${260 + i * 150} 620 V${430 + (i % 2) * 35} q55 -70 110 0 V620Z" fill="#5b4b42"/>`).join("")}`,
      };
    case "grassland":
      return {
        skyTop: "#cfe5e8",
        skyBottom: "#e5ead4",
        content: `<path d="M0 500 Q260 400 520 500 Q780 390 1200 480 L1200 800 L0 800Z" fill="#72925f"/><path d="M0 650 Q300 530 620 640 Q900 540 1200 610 L1200 800 L0 800Z" fill="#567d58"/><g fill="#f2e8d4"><path d="M230 560 L280 500 L330 560Z"/><rect x="240" y="560" width="80" height="55"/><path d="M780 570 L815 525 L850 570Z"/><rect x="785" y="570" width="62" height="46"/></g><path d="M0 720 Q600 660 1200 710" fill="none" stroke="#d8d7b0" stroke-width="16"/>`,
      };
    case "desert":
      return {
        skyTop: "#f0c477",
        skyBottom: "#c87943",
        content: `<circle cx="930" cy="170" r="74" fill="#f7dc92"/><path d="M0 430 Q220 290 470 450 Q740 280 1010 430 Q1120 360 1200 390 L1200 800 L0 800Z" fill="url(#warm)"/><path d="M0 600 Q250 470 520 610 Q770 470 1030 600 Q1120 550 1200 570 L1200 800 L0 800Z" fill="#bb7140"/><path d="M500 630 C420 630 370 670 380 710 C400 755 490 750 555 720 C590 700 565 640 525 630Z" fill="#4b9997"/><g fill="#55463a"><ellipse cx="760" cy="620" rx="28" ry="14"/><path d="M760 605 v-35 h25 v12 h-18"/><ellipse cx="845" cy="635" rx="30" ry="15"/><path d="M845 620 v-38 h26 v12 h-18"/></g>`,
      };
    case "volcano":
      return {
        skyTop: "#b7cddd",
        skyBottom: "#e6edf0",
        content: `<path d="M0 420 Q170 240 340 420 Q520 170 710 410 Q890 210 1060 420 Q1130 330 1200 360 L1200 800 L0 800Z" fill="#eff3f1"/><path d="M250 450 Q600 280 950 450 Q820 560 600 550 Q380 550 250 450Z" fill="#e4dfd7"/><path d="M330 450 Q600 330 870 450 Q760 525 600 520 Q440 520 330 450Z" fill="#3984aa"/><path d="M520 535 Q600 620 685 535 L660 690 Q600 740 540 690Z" fill="#b5e1ec"/>${cloud(260, 370, 0.9, 0.6)}`,
      };
    case "lake":
      return {
        skyTop: "#d9e9e4",
        skyBottom: "#b7d1d0",
        content: `<path d="M0 470 Q180 280 350 430 Q530 240 720 420 Q920 250 1200 430 L1200 540 L0 540Z" fill="#78907c"/><rect y="500" width="1200" height="300" fill="url(#water)"/><path d="M0 620 Q240 580 460 620 Q760 575 1200 620" fill="none" stroke="#d8ece8" stroke-width="10" opacity=".65"/><path d="M760 610 L875 635 L980 610 L920 660 H820Z" fill="#e8dfc8"/><path d="M865 610 V560 h6 v50" stroke="#584c3d" stroke-width="5"/>${cloud(240, 350, 1, 0.55)}`,
      };
    case "snow":
      return {
        skyTop: "#8eb7d0",
        skyBottom: "#dde9ed",
        content: `${mountain(240, 610, 130, 230, "#f6fafb")} ${mountain(620, 620, 90, 310, "#e7f0f4")} ${mountain(1000, 620, 160, 230, "#f6fafb")}<path d="M0 590 Q260 500 520 570 Q790 490 1200 570 L1200 800 L0 800Z" fill="#566f62"/><g stroke="#f6fafb" stroke-width="13" opacity=".85"><path d="M130 740 V560"/><path d="M190 760 V600"/><path d="M990 750 V580"/><path d="M1060 770 V620"/></g>{tree(380,650,.65,"#42634f")}`,
      };
    case "watertown":
      return {
        skyTop: "#e1ebe6",
        skyBottom: "#c6d8d2",
        content: `<rect y="480" width="1200" height="320" fill="url(#water)"/><g fill="#f3efe4" stroke="#58635c" stroke-width="6"><rect x="50" y="280" width="250" height="220"/><path d="M20 290 L175 220 L330 290Z" fill="#4e5752"/><rect x="700" y="300" width="210" height="200"/><path d="M670 310 L805 240 L940 310Z" fill="#4e5752"/><rect x="930" y="330" width="220" height="180"/><path d="M900 340 L1040 270 L1180 340Z" fill="#4e5752"/></g><path d="M350 590 Q600 350 850 590" fill="none" stroke="#4f625c" stroke-width="50"/><path d="M350 590 Q600 350 850 590" fill="none" stroke="#e5dfce" stroke-width="10"/>`,
      };
    case "mountain":
      return {
        skyTop: "#e7e6d8",
        skyBottom: "#cbd6cc",
        content: `${mountain(190, 620, 260, 210, "#738574")} ${mountain(490, 650, 130, 260, "url(#deep)")} ${mountain(800, 640, 210, 220, "#637969")} ${mountain(1080, 640, 300, 170, "#899889")}${cloud(250, 450, 1.2, 0.7)}${cloud(850, 410, 1.25, 0.65)}${tree(100, 570, 0.85)}${tree(1110, 580, 0.8)}`,
      };
    case "temple":
      return {
        skyTop: "#e6e2d5",
        skyBottom: "#c3c4af",
        content: `<path d="M0 550 Q220 430 450 520 Q720 400 1200 520 L1200 800 L0 800Z" fill="#71856f"/><g><rect x="390" y="390" width="420" height="240" fill="#eee2c9"/><path d="M320 405 L600 275 L880 405Z" fill="#8d4e3d"/><path d="M380 520 H820" stroke="#9b6f4e" stroke-width="18"/></g><g fill="#8d4e3d">${Array.from({ length: 5 }, (_, i) => `<rect x="${420 + i * 80}" y="365" width="24" height="55" rx="10"/>`).join("")}</g>${tree(180, 500, 0.7)}${tree(1020, 500, 0.72)}`,
      };
    case "island":
      return {
        skyTop: "#b8dbe5",
        skyBottom: "#f2cd96",
        content: `<circle cx="980" cy="160" r="60" fill="#f6d88a"/><rect y="500" width="1200" height="300" fill="url(#water)"/><path d="M240 650 Q420 390 700 530 Q760 570 820 650Z" fill="#5c8064"/><path d="M490 650 Q620 470 800 590" fill="#42614d"/><path d="M800 560 V420 h18 v140" stroke="#f5efe0" stroke-width="14"/><path d="M810 420 L860 445 L810 470Z" fill="#c65545"/><path d="M120 690 Q250 650 380 690" stroke="#e9f4f2" stroke-width="8" fill="none"/>`,
      };
    case "tulou":
      return {
        skyTop: "#dce5d7",
        skyBottom: "#c5c9ad",
        content: `<path d="M0 540 Q320 430 640 520 Q920 430 1200 510 L1200 800 L0 800Z" fill="#72805d"/><g fill="#b8784d" stroke="#6e503d" stroke-width="8"><circle cx="450" cy="520" r="190"/><circle cx="830" cy="540" r="150"/></g><g fill="#4e463d"><circle cx="450" cy="520" r="54"/><circle cx="830" cy="540" r="42"/></g><g stroke="#e7d1a7" stroke-width="8">${Array.from({ length: 10 }, (_, i) => `<line x1="${450 + 170 * Math.cos((i * Math.PI) / 5)}" y1="${520 + 170 * Math.sin((i * Math.PI) / 5)}" x2="${450 + 82 * Math.cos((i * Math.PI) / 5)}" y2="${520 + 82 * Math.sin((i * Math.PI) / 5)}"/>`).join("")}</g>`,
      };
    case "canyon":
      return {
        skyTop: "#d7dfd9",
        skyBottom: "#aebdb5",
        content: `<path d="M0 800 V200 L220 300 L310 800Z" fill="#5e6e63"/><path d="M1200 800 V180 L950 280 L860 800Z" fill="#68796d"/><path d="M310 800 Q520 500 600 420 Q700 550 860 800Z" fill="#8b735e"/><path d="M520 800 Q600 590 600 420 Q640 570 720 800Z" fill="#d7e3dc" opacity=".7"/>${cloud(600, 350, 1.1, 0.55)}`,
      };
    case "forest":
      return {
        skyTop: "#d6e5dc",
        skyBottom: "#aac8b7",
        content: `<path d="M0 520 Q260 390 520 490 Q790 360 1200 500 L1200 800 L0 800Z" fill="#476b56"/><path d="M0 650 Q300 520 600 650 Q900 520 1200 630 L1200 800 L0 800Z" fill="#345845"/>${tree(170, 510, 0.9, "#6c995f")}${tree(350, 550, 0.75, "#537d50")}${tree(760, 500, 1, "#5e8d56")}${tree(1010, 540, 0.85, "#6f9a60")}<path d="M0 720 Q380 650 700 720 Q930 680 1200 710" fill="none" stroke="#c6d7b8" stroke-width="18"/>`,
      };
    case "peakforest":
      return {
        skyTop: "#d9e2dc",
        skyBottom: "#aabbb1",
        content: `<path d="M0 580 Q240 450 460 550 Q710 410 960 540 Q1080 470 1200 500 L1200 800 L0 800Z" fill="#64766b"/><g fill="url(#deep)">${[160, 320, 700, 860, 1010].map((x, i) => `<path d="M${x - 70} 700 L${x - 28} ${170 + (i % 2) * 60} L${x + 20} ${120 + (i % 2) * 50} L${x + 72} 700Z"/>`).join("")}</g>${cloud(260, 500, 1, 0.6)}${cloud(850, 470, 1.1, 0.65)}`,
      };
    case "danxia":
      return {
        skyTop: "#f0d4b5",
        skyBottom: "#c99072",
        content: `<path d="M0 430 Q220 250 470 430 Q710 230 970 420 Q1100 330 1200 370 L1200 800 L0 800Z" fill="#b75f49"/><path d="M0 540 Q250 420 500 540 Q770 410 1030 540 Q1120 500 1200 520 L1200 800 L0 800Z" fill="#d58c68"/><path d="M0 650 Q260 540 540 650 Q800 520 1200 640 L1200 800 L0 800Z" fill="#e3aa7d"/><g stroke="#f1c99f" stroke-width="9" opacity=".55"><path d="M0 500 Q350 390 700 500 Q950 430 1200 470"/><path d="M0 580 Q340 470 680 580 Q950 510 1200 550"/></g>`,
      };
    case "karst":
      return {
        skyTop: "#dce9e7",
        skyBottom: "#b5d1cf",
        content: `<rect y="520" width="1200" height="280" fill="url(#water)"/><g fill="#567a6e">${[170, 410, 680, 930, 1110].map((x, i) => `<path d="M${x - 100} 540 Q${x - 90} ${250 + (i % 3) * 25} ${x} ${210 + (i % 3) * 20} Q${x + 120} ${290 + (i % 3) * 20} ${x + 110} 540Z"/>`).join("")}</g><path d="M0 600 Q260 560 520 600 Q780 550 1200 590 L1200 800 L0 800Z" fill="#639b92" opacity=".45"/><path d="M650 590 Q760 540 880 590" fill="none" stroke="#ebdfbf" stroke-width="13"/><path d="M775 500 v95" stroke="#5b4b39" stroke-width="6"/>`,
      };
    case "terrace":
      return {
        skyTop: "#d9e6d4",
        skyBottom: "#b8c69c",
        content: `<path d="M0 400 Q260 260 520 390 Q780 250 1200 380 L1200 800 L0 800Z" fill="#7b9664"/><g stroke="#d9dc94" stroke-width="26" opacity=".86">${Array.from({ length: 7 }, (_, i) => `<path d="M0 ${470 + i * 48} Q300 ${390 + i * 48} 600 ${470 + i * 48} Q900 ${390 + i * 48} 1200 ${460 + i * 48}" fill="none"/>`).join("")}</g>${cloud(260, 330, 0.85, 0.55)}`,
      };
    case "bay":
      return {
        skyTop: "#b5d9e2",
        skyBottom: "#efca9b",
        content: `<rect y="510" width="1200" height="290" fill="url(#water)"/><path d="M0 520 Q260 480 520 520 Q780 480 1200 520 L1200 690 L0 690Z" fill="#d7b06e"/><path d="M0 570 Q300 520 600 570 Q900 520 1200 570" stroke="#eef6f2" stroke-width="7" fill="none"/><path d="M910 610 L1010 630 L1100 610 L1045 655 H965Z" fill="#e8dfc9"/><path d="M1000 610 v-50 h5 v50" stroke="#584c3d" stroke-width="4"/>`,
      };
    case "waterfall":
      return {
        skyTop: "#dce8e0",
        skyBottom: "#a8c0b6",
        content: `<path d="M0 430 Q220 200 480 390 Q700 190 940 380 Q1080 300 1200 350 L1200 800 L0 800Z" fill="#4f6d5b"/><path d="M500 300 Q600 520 520 800" fill="none" stroke="#e9f6f2" stroke-width="62" opacity=".9"/><path d="M690 340 Q740 570 690 800" fill="none" stroke="#d6eeeb" stroke-width="38" opacity=".85"/><path d="M0 650 Q300 570 600 650 Q900 570 1200 650 L1200 800 L0 800Z" fill="#6ca6aa" opacity=".75"/>`,
      };
    case "history":
      return {
        skyTop: "#e1d7c2",
        skyBottom: "#bcb29d",
        content: `<path d="M0 520 Q300 440 600 520 Q900 440 1200 510 L1200 800 L0 800Z" fill="#8d8169"/><g fill="url(#deep)">${[180, 420, 660, 900, 1080].map((x, i) => `<path d="M${x - 70} 560 L${x - 45} ${420 - (i % 2) * 35} L${x} ${340 - (i % 2) * 45} L${x + 45} ${420 - (i % 2) * 35} L${x + 70} 560Z"/>`).join("")}</g><path d="M0 680 Q300 620 600 680 Q900 620 1200 680" fill="none" stroke="#d6c7a7" stroke-width="12"/>`,
      };
    case "saltlake":
      return {
        skyTop: "#b9d9e8",
        skyBottom: "#e7eef2",
        content: `<path d="M0 430 Q240 300 480 420 Q720 300 1200 410 L1200 560 L0 560Z" fill="#7d9aa2"/><rect y="500" width="1200" height="300" fill="#dce9ed"/><path d="M0 590 Q300 550 600 590 Q900 550 1200 590" stroke="#a8cad4" stroke-width="18" fill="none"/><path d="M320 760 L760 650" stroke="#756a62" stroke-width="10"/><path d="M340 748 L780 638" stroke="#756a62" stroke-width="10"/><rect x="530" y="650" width="110" height="55" rx="10" fill="#f2f5f4"/><circle cx="555" cy="710" r="14" fill="#5e6664"/><circle cx="620" cy="710" r="14" fill="#5e6664"/>`,
      };
    case "harbour":
      return {
        skyTop: "#b9d7e2",
        skyBottom: "#e8c998",
        content: `<rect y="540" width="1200" height="260" fill="url(#water)"/><g fill="#5c6e77">${Array.from({ length: 10 }, (_, i) => `<rect x="${40 + i * 110}" y="${380 - (i % 4) * 40}" width="72" height="${210 + (i % 4) * 40}"/>`).join("")}</g><path d="M190 650 L390 650 L440 690 H160Z" fill="#f2ead9"/><path d="M290 650 v-60 h8 v60" stroke="#4e5958" stroke-width="5"/><path d="M0 730 Q300 680 600 730 Q900 680 1200 730" stroke="#cbe7eb" stroke-width="8" fill="none"/>`,
      };
  }
}

export function renderSceneSvg(input: {
  id: string;
  name: string;
  art: SceneArt;
  accent: string;
  visualSeed: number;
}): string {
  const tone = adjustColor(input.accent, input.visualSeed);
  const rendered = specialRender(input.id) ?? render(input.art, tone);
  const mirror = input.visualSeed % 2 === 1 ? -1 : 1;
  const scale = 0.965 + ((input.visualSeed >> 8) % 7) * 0.011;
  const shiftX = (((input.visualSeed >> 2) % 9) - 4) * 8;
  const shiftY = (((input.visualSeed >> 6) % 5) - 2) * 6;
  const content = `<g transform="translate(${600 + shiftX} ${400 + shiftY}) scale(${mirror * scale} ${scale}) translate(-600 -400)">${rendered.content}</g>${signatureMotif(input.visualSeed, tone)}`;

  return wrap(
    input.name,
    adjustColor(rendered.skyTop, input.visualSeed),
    adjustColor(rendered.skyBottom, input.visualSeed),
    content,
    tone,
  );
}

export function sceneDataUrl(input: Parameters<typeof renderSceneSvg>[0]): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderSceneSvg(input))}`;
}

function dynamicVisualSeed(value: string): number {
  // PostgreSQL integer is signed 31-bit for positive values.
  return hashString(value) & 0x7fffffff;
}

export function createUniqueVisualSeed(
  canonicalKey: string,
  usedSeeds: ReadonlySet<number>,
): number {
  const maxRetries = 10_000;
  let candidate = dynamicVisualSeed(canonicalKey);

  // Check the base candidate, then retry with each of the 10,000 salted candidates.
  for (let retry = 0; retry <= maxRetries; retry += 1) {
    if (!usedSeeds.has(candidate)) return candidate;
    if (retry === maxRetries) break;
    candidate = dynamicVisualSeed(`${canonicalKey}:${retry + 1}`);
  }

  throw new Error("无法分配唯一视觉种子");
}
