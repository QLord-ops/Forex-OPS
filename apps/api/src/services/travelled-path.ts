import type { Coordinate } from "../domain.js";
import { projectOnLine } from "./route-projection.js";
import { calculateHaversineDistanceMeters } from "./simulation.js";

/** A stitch whose ends are farther apart than this is not drawn as a line: the truck left the planned route there. */
export const JOIN_GAP_METERS = 1_000;
/** No routing provider puts two points of one road this far apart, so older stored routes with such a jump have a stitch there. */
export const STORED_JUMP_METERS = 5_000;
/** How far back from the stitch the driven part is searched for the point where the truck really turned off. */
const TAIL_SEARCH_METERS = 80_000;
/** Cut only when that point is clearly closer than the end of the piece, so a normal stitch stays as it is. */
const MIN_SPUR_METERS = 300;

export type TravelledPath = {
  points: Coordinate[];
  /** Index of the first point of each new piece; the line is not drawn from the point before it. `points.length` = the new route starts apart. */
  breaks: number[];
  /** Index of the first point of every piece after the first, to be stored with the prefix for the next stitch. */
  starts: number[];
};

/**
 * Cuts off the part of a piece that the truck did not drive: the old plan ran on past the point where the truck turned off
 * (e.g. on along the A44 while the truck took the A7). The piece then ends at the point closest to where the next piece starts.
 */
function trimSpur(piece: Coordinate[], next: Coordinate): Coordinate[] {
  if (piece.length < 2) return piece;
  let from = piece.length - 1;
  for (let walked = 0; from > 0 && walked < TAIL_SEARCH_METERS; from -= 1) walked += calculateHaversineDistanceMeters(piece[from - 1], piece[from]);
  const tail = piece.slice(from);
  const projection = projectOnLine(tail, next);
  if (!projection) return piece;
  if (calculateHaversineDistanceMeters(piece[piece.length - 1], next) - projection.offMeters < MIN_SPUR_METERS) return piece;
  return [...piece.slice(0, from + projection.index + 1), projection.point];
}

/**
 * The driven part of a leg, stored as stitched pieces of earlier routes, cleaned for the map:
 * no stretch the truck did not drive, and no straight line across the country where two pieces do not meet.
 */
export function cleanTravelled(prefix: Coordinate[], start: Coordinate | null, storedStarts: unknown = []): TravelledPath {
  if (!prefix.length) return { points: [], breaks: [], starts: [] };
  const cuts = new Set((Array.isArray(storedStarts) ? storedStarts : []).filter((index): index is number => Number.isInteger(index) && index > 0 && index < prefix.length));
  for (let index = 1; index < prefix.length; index += 1) {
    if (calculateHaversineDistanceMeters(prefix[index - 1], prefix[index]) > STORED_JUMP_METERS) cuts.add(index);
  }
  const bounds = [0, ...[...cuts].sort((a, b) => a - b), prefix.length];
  const pieces = bounds.slice(0, -1).map((from, index) => prefix.slice(from, bounds[index + 1]));
  const points: Coordinate[] = [];
  const breaks: number[] = [];
  const starts: number[] = [];
  pieces.forEach((piece, index) => {
    const next = index + 1 < pieces.length ? pieces[index + 1][0] : start;
    const trimmed = next ? trimSpur(piece, next) : piece;
    if (index > 0 && points.length) {
      starts.push(points.length);
      if (calculateHaversineDistanceMeters(points[points.length - 1], trimmed[0]) > JOIN_GAP_METERS) breaks.push(points.length);
    }
    points.push(...trimmed);
  });
  if (start && calculateHaversineDistanceMeters(points[points.length - 1], start) > JOIN_GAP_METERS) breaks.push(points.length);
  return { points, breaks, starts };
}
