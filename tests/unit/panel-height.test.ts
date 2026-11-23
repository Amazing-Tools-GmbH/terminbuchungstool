/** Pipedrive-Panel: Höhe für das SDK (nur 100–750 px erlaubt, sonst lehnt Pipedrive die Initialisierung ab) */
import { describe, expect, it } from "vitest";
import { panelHeight, PANEL_MAX_HEIGHT, PANEL_MIN_HEIGHT } from "@/components/panel/usePipedriveSdk";

describe("panelHeight", () => {
  it.each([
    [1200, PANEL_MAX_HEIGHT],
    [750, 750],
    [420.2, 421],
    [40, PANEL_MIN_HEIGHT],
    [0, PANEL_MIN_HEIGHT],
    [Number.NaN, PANEL_MIN_HEIGHT],
  ])("%s px -> %s px", (input, expected) => {
    expect(panelHeight(input)).toBe(expected);
  });
});
