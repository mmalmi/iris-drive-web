/**
 * Layouts: the empty text boxes a new slide starts with. A layout is only a
 * starting point; once made, the boxes are ordinary elements.
 */
import { SLIDE_HEIGHT, SLIDE_WIDTH, type ElementInit, type TextRole } from './model';

export interface Layout {
  id: string;
  name: string;
  elements: ElementInit[];
}

const MARGIN = 88;
const INNER = SLIDE_WIDTH - MARGIN * 2;
const GAP = 48;
// Room for a title of two lines, held to the bottom so one line and two both sit just above the text.
const TITLE_TOP = 32;
const TITLE_HEIGHT = 134;

function box(role: TextRole, x: number, y: number, w: number, h: number, extra: Partial<ElementInit> = {}): ElementInit {
  return { type: 'text', role, x, y, w, h, rot: 0, ...extra };
}

export const LAYOUTS: Layout[] = [
  {
    id: 'title',
    name: 'Title',
    elements: [
      box('title', MARGIN, 190, INNER, 190, { valign: 'bottom' }),
      box('subtitle', MARGIN, 404, INNER, 90),
    ],
  },
  {
    id: 'content',
    name: 'Title and text',
    elements: [
      box('title', MARGIN, TITLE_TOP, INNER, TITLE_HEIGHT, { valign: 'bottom' }),
      box('body', MARGIN, 184, INNER, SLIDE_HEIGHT - 184 - 72),
    ],
  },
  {
    id: 'columns',
    name: 'Two columns',
    elements: [
      box('title', MARGIN, TITLE_TOP, INNER, TITLE_HEIGHT, { valign: 'bottom' }),
      box('body', MARGIN, 184, (INNER - GAP) / 2, SLIDE_HEIGHT - 184 - 72),
      box('body', MARGIN + (INNER + GAP) / 2, 184, (INNER - GAP) / 2, SLIDE_HEIGHT - 184 - 72),
    ],
  },
  {
    id: 'section',
    name: 'Section',
    elements: [
      box('title', MARGIN, 250, INNER, 130, { valign: 'bottom' }),
      box('subtitle', MARGIN, 400, INNER, 70),
    ],
  },
  {
    id: 'blank',
    name: 'Blank',
    elements: [],
  },
];

export const DEFAULT_LAYOUT = 'content';

export function layoutById(id: string | undefined): Layout {
  return LAYOUTS.find(layout => layout.id === id) ?? LAYOUTS.find(layout => layout.id === 'blank')!;
}

/** What an empty text box asks for. */
export function placeholderFor(role: TextRole | undefined): string {
  if (role === 'title') return 'Add a title';
  if (role === 'subtitle') return 'Add a subtitle';
  return 'Add text';
}
