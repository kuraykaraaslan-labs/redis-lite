import { formatMessage } from '@/libs/message-format';
import { RespVerbatim } from '@/libs/resp';
import type { Reply } from '@/libs/resp';

import type { CommandContext } from '@/modules/command/command.types';

import { REDIS_VERSION } from './server.constants';
import type { LolwutInput } from './server.dto';
import ServerMessages from './server.messages';

/** LOLWUT: computer art and the Redis version. */
export default class ServerLolwutService {
  // ──────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────

  /** LOLWUT VERSION 5: Georg Nees' "Schotter" rendered with braille characters (Redis lolwut5.c). */
  private static render(cols: number, perRow: number, perCol: number): string {
    const width = cols * 2;
    const padding = width > 4 ? 2 : 0;
    const side = (width - padding * 2) / perRow;
    const height = Math.trunc(side * perCol + padding * 2);
    const pixels = new Uint8Array(width * height);
    const set = (x: number, y: number) => {
      if (x >= 0 && y >= 0 && x < width && y < height) pixels[x + y * width] = 1;
    };
    const line = (x1: number, y1: number, x2: number, y2: number) => {
      const dx = Math.abs(x2 - x1);
      const dy = Math.abs(y2 - y1);
      const sx = x1 < x2 ? 1 : -1;
      const sy = y1 < y2 ? 1 : -1;
      let err = dx - dy;
      for (;;) {
        set(x1, y1);
        if (x1 === x2 && y1 === y2) break;
        const e2 = err * 2;
        if (e2 > -dy) {
          err -= dy;
          x1 += sx;
        }
        if (e2 < dx) {
          err += dx;
          y1 += sy;
        }
      }
    };
    for (let y = 0; y < perCol; y++) {
      for (let x = 0; x < perRow; x++) {
        let sx = Math.trunc(x * side + side / 2 + padding);
        let sy = Math.trunc(y * side + side / 2 + padding);
        let angle = 0;
        if (y > 1) {
          const r = () => (Math.random() / perCol) * y * (Math.random() < 0.5 ? -1 : 1);
          angle = r();
          sx += Math.trunc((r() * side) / 3);
          sy += Math.trunc((r() * side) / 3);
        }
        const size = Math.round(side / 1.4142135623);
        const px: number[] = [];
        const py: number[] = [];
        let k = Math.PI / 4 + angle;
        for (let j = 0; j < 4; j++) {
          px.push(Math.round(Math.sin(k) * size + sx));
          py.push(Math.round(Math.cos(k) * size + sy));
          k += Math.PI / 2;
        }
        for (let j = 0; j < 4; j++) line(px[j], py[j], px[(j + 1) % 4], py[(j + 1) % 4]);
      }
    }
    const get = (x: number, y: number): number => (x < width && y < height ? pixels[x + y * width] : 0);
    const rows: string[] = [];
    for (let y = 0; y < height; y += 4) {
      let row = '';
      for (let x = 0; x < width; x += 2) {
        const byte =
          get(x, y) | (get(x, y + 1) << 1) | (get(x, y + 2) << 2) | (get(x + 1, y) << 3) | (get(x + 1, y + 1) << 4) | (get(x + 1, y + 2) << 5) |
          (get(x, y + 3) << 6) | (get(x + 1, y + 3) << 7);
        row += String.fromCodePoint(0x2800 + byte);
      }
      rows.push(`${row}\n`);
    }
    return rows.join('');
  }

  /**
   * LOLWUT VERSION 6: a random city skyline on a `cols` x `rows` canvas, one ANSI-coloured cell per pixel (white sky,
   * then light grey, dark grey and black buildings from the farthest to the nearest, with lit windows).
   */
  private static skyline(cols: number, rows: number): string {
    const SHADES = ['0;97;107', '0;37;47', '0;90;100', '0;30;40'];
    const canvas = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
    const rand = (min: number, max: number): number => min + Math.floor(Math.random() * (max - min + 1));
    for (let layer = 1; layer <= 3; layer++) {
      const maxHeight = Math.max(1, Math.floor((rows * (5 - layer)) / 5));
      for (let x = rand(-4, 0); x < cols; ) {
        const width = rand(3, 10);
        const height = rand(Math.max(1, Math.floor(maxHeight / 3)), maxHeight);
        for (let dx = 0; dx < width; dx++) {
          for (let dy = 0; dy < height; dy++) {
            const px = x + dx;
            const py = rows - 1 - dy;
            if (px < 0 || px >= cols || py < 0) continue;
            const window = layer > 1 && dx % 2 === 1 && dy % 2 === 1 && dx < width - 1 && dy < height - 1 && Math.random() < 0.5;
            canvas[py][px] = window ? layer - 1 : layer;
          }
        }
        x += width + rand(0, 3);
      }
    }
    return canvas.map((line) => `${line.map((c) => `\x1b[${SHADES[c]}m \x1b[0m`).join('')}\n`).join('');
  }

  // ──────────────────────────────────────────────
  // Public Methods
  // ──────────────────────────────────────────────

  /** LOLWUT [VERSION v] [options]: version 5 draws Schotter, version 6 a skyline, any other only the version. */
  static lolwut(_ctx: CommandContext, { version, cols, perRow, perCol }: LolwutInput): Reply {
    let text: string;
    if (version === 5) {
      text = `${ServerLolwutService.render(cols, perRow, perCol)}${formatMessage(ServerMessages.LOLWUT_5_CAPTION, { version: REDIS_VERSION })}`;
    } else if (version === 6) {
      text = `${ServerLolwutService.skyline(cols, perRow)}${formatMessage(ServerMessages.LOLWUT_6_CAPTION, { version: REDIS_VERSION })}`;
    } else text = formatMessage(ServerMessages.LOLWUT_CAPTION, { version: REDIS_VERSION });
    return new RespVerbatim(Buffer.from(text, 'utf8').toString('latin1'));
  }
}
