import { afterEach, describe, expect, it, vi } from "vitest";
import type { ViewerState } from "../src/app/serve.js";
import type { Diagram, Pin, Point } from "../src/core/geometry.js";
import { NotebookCanvas } from "../src/viewer/canvas.js";

const diagram = (origin?: Point): Diagram => ({
  origin, width: 600, height: 400, notes: [], labels: [], edges: [], meta: { engine: "test" },
  nodes: [{ id: "E:ITEM", kind: "entity", label: "ITEM", double: false, box: { x: -120, y: -160, w: 110, h: 46 } }],
});

function harness(d: Diagram) {
  const sheet = { style: { transform: "", width: "", height: "" } };
  const next = { style: {}, setAttribute: vi.fn(), getAttribute: (key: string) => key === "height" ? "452" : null };
  const figure = { querySelector: (selector: string) => selector === "svg:last-child" ? null : next, querySelectorAll: () => [], append: vi.fn(), classList: { toggle: vi.fn() } };
  const overlay = { setAttribute: vi.fn(), contains: () => false };
  const canvas = {
    clientWidth: 1000, clientHeight: 800, style: { setProperty: vi.fn() },
    getBoundingClientRect: () => ({ left: 100, top: 50 }),
    setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn(), focus: vi.fn(),
  };
  const pin = vi.fn(async (_id: string, _point: Pin | null) => {});
  const state = { diagram: d, svg: "<svg/>", pins: {}, computing: false } as ViewerState;
  const notebook = Object.assign(Object.create(NotebookCanvas.prototype), {
    good: state, state, scale: 2, offset: { x: 300, y: 400 }, sheet, figure, overlay, canvas,
    pin, actions: vi.fn(), touches: new Map(), drawOverlay: vi.fn(), lastNodeIds: "", exportCorners: [], group: () => undefined,
  }) as {
    good: ViewerState | undefined; scale: number; offset: Point;
    transform(): void; fit(): void; diagramPoint(p: Point): Point; zoom(factor: number, around: Point): void;
    show(state: ViewerState, list: []): void;
    key(e: KeyboardEvent): void;
    down(e: PointerEvent): void; move(e: PointerEvent): void; up(e: PointerEvent): void;
  };
  const placeholder = { hidden: false, textContent: "" };
  vi.stubGlobal("document", { activeElement: null, querySelector: (selector: string) => selector === "#placeholder" ? placeholder : { setAttribute: vi.fn(), focus: vi.fn() } });
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  vi.stubGlobal("DOMParser", class { parseFromString() { return { documentElement: next }; } });
  Object.assign(document, { importNode: () => next });
  return { notebook, sheet, overlay, pin, state };
}

afterEach(() => vi.unstubAllGlobals());

describe("viewer canvas origin", () => {
  it("fits the whole sheet including notes and keeps screen conversions in diagram coordinates", () => {
    const { notebook, sheet } = harness(diagram({ x: -200, y: -300 }));
    notebook.fit();
    expect(notebook.scale).toBe(1.5);
    expect(notebook.offset).toEqual({ x: 350, y: 511 });
    expect(sheet.style.transform).toBe("translate(350px, 511px) scale(1.5) translate(-200px, -300px)");
    expect(notebook.diagramPoint({ x: 500, y: 400 })).toEqual({ x: 100, y: -74 });
    const around = { x: 425, y: 350 };
    const point = notebook.diagramPoint(around);
    notebook.zoom(0.5, around);
    expect(notebook.diagramPoint(around)).toEqual(point);
  });

  it("updates the overlay and sheet transform when a later layout changes origin", () => {
    const { notebook, sheet, overlay, state } = harness(diagram());
    vi.stubGlobal("SVGGElement", class {});
    notebook.show({ ...state, diagram: diagram({ x: -200, y: -300 }) }, []);
    expect(overlay.setAttribute).toHaveBeenCalledWith("viewBox", "-200 -300 600 452");
    expect(sheet.style.transform).toBe("translate(300px, 400px) scale(2) translate(-200px, -300px)");
    notebook.show({ ...state, diagram: diagram() }, []);
    expect(overlay.setAttribute).toHaveBeenCalledWith("viewBox", "0 0 600 452");
    expect(sheet.style.transform).toBe("translate(300px, 400px) scale(2) translate(0px, 0px)");
  });

  it("uses the origin on initial fit", () => {
    const { notebook, sheet, state } = harness(diagram({ x: -200, y: -300 }));
    vi.stubGlobal("SVGGElement", class {});
    notebook.good = undefined;
    notebook.show(state, []);
    expect(sheet.style.transform).toBe("translate(350px, 511px) scale(1.5) translate(-200px, -300px)");
  });

  it("sends relative attribute offsets on pointer drop and arrow movement, and Delete removes the pin", async () => {
    const d = diagram({ x: -200, y: -300 });
    d.nodes.push({ id: "A:ITEM.Name", kind: "attribute", label: "Name", double: false, box: { x: -210, y: -252, w: 100, h: 34 } });
    d.edges.push({ id: "edge:A:ITEM.Name", kind: "attribute", from: "E:ITEM", to: "A:ITEM.Name", points: [], double: false });
    const { notebook, pin, state } = harness(d);
    state.pins = { "A:ITEM.Name": { dx: -95, dy: -98 } };
    class Group {
      dataset = { id: "A:ITEM.Name" };
      closest(selector: string) { return selector.startsWith(".er-entity") ? this : null; }
      focus() {}
      setAttribute = vi.fn(); removeAttribute = vi.fn();
    }
    vi.stubGlobal("Element", Group); const group = new Group();
    const event = (clientX: number, clientY: number) => ({ button: 0, pointerId: 1, target: group, clientX, clientY, altKey: true }) as unknown as PointerEvent;
    notebook.down({ ...event(80, -20), altKey: false } as PointerEvent); notebook.move(event(112, -4)); notebook.up(event(112, -4));
    await Promise.resolve(); await Promise.resolve();
    expect(pin).toHaveBeenCalledWith("A:ITEM.Name", { dx: -79, dy: -90 });
    notebook.key({ key: "ArrowRight", altKey: true, preventDefault: vi.fn() } as unknown as KeyboardEvent);
    expect(pin).toHaveBeenLastCalledWith("A:ITEM.Name", { dx: -87, dy: -98 });
    notebook.key({ key: "Delete", preventDefault: vi.fn() } as unknown as KeyboardEvent);
    expect(pin).toHaveBeenLastCalledWith("A:ITEM.Name", null);
  });

  it.each([false, true])("saves a dragged node above y=0 in diagram coordinates (free=%s)", async (free) => {
    const { notebook, pin } = harness(diagram({ x: -200, y: -300 }));
    class Group {
      dataset = { id: "E:ITEM" };
      closest(selector: string) { return selector.startsWith(".er-entity") ? this : null; }
      focus() {}
      setAttribute = vi.fn();
      removeAttribute = vi.fn();
    }
    vi.stubGlobal("Element", Group);
    const group = new Group();
    // Node center (-65, -137) appears at local (170, 126) at scale 2.
    const event = (clientX: number, clientY: number) => ({ button: 0, pointerId: 1, target: group, clientX, clientY, altKey: free }) as unknown as PointerEvent;
    notebook.down(event(270, 176));
    notebook.move(event(302, 96));
    notebook.up(event(302, 96));
    await Promise.resolve();
    expect(pin).toHaveBeenCalledWith("E:ITEM", free ? { x: -49, y: -177 } : { x: -48, y: -176 });
    expect(group.removeAttribute).toHaveBeenCalledWith("transform");
  });
});

describe("viewer specialization interaction", () => {
  const specialized = (): Diagram => ({ ...diagram(), nodes: [
    { id: "S:ITEM.0", kind: "specialization", label: "ITEM.0", double: false, box: { x: 20, y: 30, w: 30, h: 30 } },
  ] });

  it("makes a symbol-free specialization focusable with an invisible pointer target", () => {
    const { notebook, state } = harness(specialized());
    const group = { setAttribute: vi.fn(), addEventListener: vi.fn(), append: vi.fn() };
    const circle = { setAttribute: vi.fn() };
    Object.assign(notebook, { group: () => group });
    Object.assign(document, { createElementNS: vi.fn(() => circle) });
    vi.stubGlobal("SVGGElement", class {});
    notebook.show(state, []);
    expect(group.setAttribute).toHaveBeenCalledWith("tabindex", "0");
    expect(group.setAttribute).toHaveBeenCalledWith("role", "button");
    expect(group.append).toHaveBeenCalledWith(circle);
    expect(circle.setAttribute).toHaveBeenCalledWith("fill", "transparent");
    expect(circle.setAttribute).toHaveBeenCalledWith("pointer-events", "all");
    expect(circle.setAttribute).toHaveBeenCalledWith("r", "15");
    vi.stubGlobal("Element", class {});
    const focus = group.addEventListener.mock.calls.find(([event]) => event === "focus")![1];
    expect(() => focus()).not.toThrow();
    notebook.key({ key: "ArrowRight", altKey: true, preventDefault: vi.fn() } as unknown as KeyboardEvent);
  });

  it("draws a circular halo and safely focuses specialization and edge selections", () => {
    const d = specialized();
    d.edges.push({ id: "edge:S:ITEM.0#super", kind: "end", from: "S:ITEM.0", to: "E:ITEM", points: [{ x: 35, y: 30 }, { x: 35, y: 0 }], double: true });
    const { notebook } = harness(d);
    const shape = { setAttribute: vi.fn() }, create = vi.fn(() => shape);
    Object.assign(document, { createElementNS: create });
    const access = notebook as unknown as { haloShape(id: string, attrs: {}): unknown; selectElement(id: string): boolean; focusSelection(): void };
    expect(access.haloShape("S:ITEM.0", {})).toBe(shape);
    expect(create).toHaveBeenCalledWith("http://www.w3.org/2000/svg", "circle");
    expect(shape.setAttribute).toHaveBeenCalledWith("r", "21");
    expect(access.selectElement("S:ITEM.0")).toBe(true);
    expect(() => access.focusSelection()).not.toThrow();
    Object.assign(notebook, { selected: "edge:S:ITEM.0#super" });
    expect(() => access.focusSelection()).not.toThrow();
    expect(() => access.haloShape("edge:S:ITEM.0#super", {})).not.toThrow();
  });

  it("drags and keyboard-pins a specialization using its absolute center", async () => {
    const { notebook, pin } = harness(specialized());
    class Group {
      dataset = { id: "S:ITEM.0" };
      closest(selector: string) { return selector.includes(".er-specialization") ? this : null; }
      focus() {}
      setAttribute = vi.fn(); removeAttribute = vi.fn();
    }
    vi.stubGlobal("Element", Group);
    const group = new Group();
    const event = (clientX: number, clientY: number) => ({ button: 0, pointerId: 1, target: group, clientX, clientY, altKey: true }) as unknown as PointerEvent;
    notebook.down(event(470, 540)); notebook.move(event(502, 556)); notebook.up(event(502, 556));
    await Promise.resolve(); await Promise.resolve();
    expect(pin).toHaveBeenCalledWith("S:ITEM.0", { x: 51, y: 53 });
    notebook.key({ key: "ArrowRight", altKey: true, preventDefault: vi.fn() } as unknown as KeyboardEvent);
    expect(pin).toHaveBeenLastCalledWith("S:ITEM.0", { x: 43, y: 45 });
    notebook.key({ key: "Enter", preventDefault: vi.fn() } as unknown as KeyboardEvent);
    notebook.key({ key: "Delete", preventDefault: vi.fn() } as unknown as KeyboardEvent);
    expect(pin).toHaveBeenLastCalledWith("S:ITEM.0", null);
  });
});
