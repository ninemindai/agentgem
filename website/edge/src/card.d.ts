export type CardCounts = { breadth: number; battleTested: number; portable: number };
export function renderCardSvg(counts: CardCounts): string;
export function cardDescription(counts: CardCounts): string;
