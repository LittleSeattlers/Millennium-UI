type Point = readonly [number, number];

type GemArt = {
  deep: string;
  mid: string;
  light: string;
  width: number;
  height: number;
  points?: readonly Point[];
  ellipse?: true;
  rotation?: number;
};

const GEM_ART: Record<string, GemArt> = {
  ruby: {
    deep: '#7a1628', mid: '#d62748', light: '#ff9aac', width: 48, height: 48,
    points: [[.2, 0], [.8, 0], [1, .2], [1, .8], [.8, 1], [.2, 1], [0, .8], [0, .2]],
  },
  citrine: {
    deep: '#a84208', mid: '#ed8616', light: '#ffd36a', width: 44, height: 50,
    points: [[.5, 0], [.78, .2], [.96, .51], [.88, .81], [.5, 1], [.12, .81], [.04, .51], [.22, .2]],
  },
  emerald: {
    deep: '#07572f', mid: '#159653', light: '#8be099', width: 42, height: 50,
    points: [[.22, 0], [.78, 0], [1, .18], [1, .82], [.78, 1], [.22, 1], [0, .82], [0, .18]],
  },
  aquamarine: {
    deep: '#08708b', mid: '#15b7cc', light: '#a6f2f3', width: 36, height: 48, rotation: 20,
    points: [[.5, 0], [.82, .18], [1, .5], [.82, .82], [.5, 1], [.18, .82], [0, .5], [.18, .18]],
  },
  amethyst: {
    deep: '#4f147b', mid: '#8f2dcc', light: '#d796ff', width: 50, height: 43,
    points: [[.5, 0], [1, 1], [0, 1]],
  },
  sapphire: {
    deep: '#124ca3', mid: '#237ce3', light: '#9ed4ff', width: 40, height: 50, ellipse: true,
  },
  moonstone: {
    deep: '#9c875e', mid: '#e3d4af', light: '#fffdf0', width: 48, height: 46,
    points: [[.25, 0], [.75, 0], [1, .5], [.75, 1], [.25, 1], [0, .5]],
  },
};

export function installGemFavicon(gemName: string) {
  const gem = GEM_ART[gemName];
  if (!gem) return;
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  if (!context) return;

  drawGem(context, gem);

  const existingIcon = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  const icon = existingIcon ?? document.createElement('link');
  icon.rel = 'icon';
  icon.type = 'image/png';
  icon.sizes = '64x64';
  icon.href = canvas.toDataURL('image/png');
  if (!existingIcon) document.head.append(icon);
  document.documentElement.dataset.faviconGem = gemName;
}

function drawGem(context: CanvasRenderingContext2D, gem: GemArt) {
  const x = (64 - gem.width) / 2;
  const y = (64 - gem.height) / 2;
  const inset = 4;

  context.save();
  context.translate(32, 32);
  context.rotate(((gem.rotation ?? 0) * Math.PI) / 180);
  context.translate(-32, -32);

  const outer = gemPath(gem, x, y, gem.width, gem.height);
  context.shadowColor = 'rgba(5, 20, 34, .42)';
  context.shadowBlur = 5;
  context.shadowOffsetY = 2;
  context.fillStyle = '#d7aa47';
  context.fill(outer);

  context.shadowColor = 'transparent';
  const inner = gemPath(gem, x + inset, y + inset, gem.width - inset * 2, gem.height - inset * 2);
  const color = context.createLinearGradient(x + 8, y + 5, x + gem.width - 5, y + gem.height);
  color.addColorStop(0, gem.light);
  color.addColorStop(.38, gem.mid);
  color.addColorStop(1, gem.deep);
  context.fillStyle = color;
  context.fill(inner);

  context.save();
  context.clip(inner);
  const sheen = context.createLinearGradient(x, y, x + gem.width, y + gem.height);
  sheen.addColorStop(0, 'rgba(255, 255, 255, .78)');
  sheen.addColorStop(.3, 'rgba(255, 255, 255, .08)');
  sheen.addColorStop(.58, 'rgba(255, 255, 255, 0)');
  context.fillStyle = sheen;
  context.fillRect(x, y, gem.width, gem.height);

  context.strokeStyle = 'rgba(255, 255, 255, .27)';
  context.lineWidth = 1.25;
  const centerX = 32;
  const centerY = 33;
  for (const [pointX, pointY] of facetAnchors(gem)) {
    context.beginPath();
    context.moveTo(centerX, centerY);
    context.lineTo(x + pointX * gem.width, y + pointY * gem.height);
    context.stroke();
  }
  context.restore();

  context.strokeStyle = 'rgba(255, 247, 211, .7)';
  context.lineWidth = 1;
  context.stroke(inner);
  context.restore();
}

function gemPath(gem: GemArt, x: number, y: number, width: number, height: number) {
  const path = new Path2D();
  if (gem.ellipse) {
    path.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
    return path;
  }

  gem.points?.forEach(([pointX, pointY], index) => {
    const draw = index === 0 ? path.moveTo.bind(path) : path.lineTo.bind(path);
    draw(x + pointX * width, y + pointY * height);
  });
  path.closePath();
  return path;
}

function facetAnchors(gem: GemArt): readonly Point[] {
  return gem.points ?? [[.5, 0], [1, .5], [.5, 1], [0, .5]];
}
