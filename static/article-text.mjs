// Offsets are Unicode code points, matching Python/spaCy rather than JS UTF-16 units.
export function sentenceParts(text, spans) {
  const characters = Array.from(text);
  const valid = (spans || []).filter(span => Array.isArray(span) && span.length === 2 && span.every(Number.isInteger) && span[0] >= 0 && span[1] > span[0] && span[1] <= characters.length).sort((a,b) => a[0]-b[0] || a[1]-b[1]);
  const merged = [];
  for (const [start,end] of valid) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1],end);
    else merged.push([start,end]);
  }
  const parts = []; let offset = 0;
  for (const [start,end] of merged) {
    if (start > offset) parts.push({text:characters.slice(offset,start).join(''),highlight:false});
    parts.push({text:characters.slice(start,end).join(''),highlight:true}); offset = end;
  }
  if (offset < characters.length) parts.push({text:characters.slice(offset).join(''),highlight:false});
  return parts;
}
