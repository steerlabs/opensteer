import { brand, type Brand } from "./brand.js";

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export type Quad = readonly [Point, Point, Point, Point];

export interface ScrollOffset {
  readonly x: number;
  readonly y: number;
}

export type CoordinateSpace =
  | "document-css"
  | "layout-viewport-css"
  | "visual-viewport-css"
  | "computer-display-css"
  | "window"
  | "screen"
  | "device-pixel";

export interface LayoutViewport {
  readonly origin: Point;
  readonly size: Size;
}

export interface VisualViewport {
  readonly origin: Point;
  readonly offsetWithinLayoutViewport: ScrollOffset;
  readonly size: Size;
}

export type DevicePixelRatio = Brand<number, "DevicePixelRatio">;
export type PageScaleFactor = Brand<number, "PageScaleFactor">;
export type PageZoomFactor = Brand<number, "PageZoomFactor">;

export interface ViewportMetrics {
  readonly layoutViewport: LayoutViewport;
  readonly visualViewport: VisualViewport;
  readonly scrollOffset: ScrollOffset;
  readonly contentSize: Size;
  readonly devicePixelRatio: DevicePixelRatio;
  readonly pageScaleFactor: PageScaleFactor;
  readonly pageZoomFactor: PageZoomFactor;
}

function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
}

function assertNonNegative(value: number, name: string): void {
  assertFinite(value, name);
  if (value < 0) {
    throw new RangeError(`${name} must be greater than or equal to 0`);
  }
}

function createScale<Name extends string>(value: number, name: string) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be greater than 0`);
  }
  return brand<number, Name>(value);
}

export function createPoint(x: number, y: number): Point {
  assertFinite(x, "point.x");
  assertFinite(y, "point.y");
  return { x, y };
}

export function createSize(width: number, height: number): Size {
  assertNonNegative(width, "size.width");
  assertNonNegative(height, "size.height");
  return { width, height };
}

export function createRect(x: number, y: number, width: number, height: number): Rect {
  assertFinite(x, "rect.x");
  assertFinite(y, "rect.y");
  assertNonNegative(width, "rect.width");
  assertNonNegative(height, "rect.height");
  return { x, y, width, height };
}

export function createScrollOffset(x: number, y: number): ScrollOffset {
  assertFinite(x, "scrollOffset.x");
  assertFinite(y, "scrollOffset.y");
  return { x, y };
}

export function createQuad(points: readonly [Point, Point, Point, Point]): Quad {
  return points;
}

export function rectToQuad(rect: Rect): Quad {
  return createQuad([
    createPoint(rect.x, rect.y),
    createPoint(rect.x + rect.width, rect.y),
    createPoint(rect.x + rect.width, rect.y + rect.height),
    createPoint(rect.x, rect.y + rect.height),
  ]);
}

export function quadBounds(quad: Quad): Rect {
  const xs = quad.map((point) => point.x);
  const ys = quad.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return createRect(minX, minY, maxX - minX, maxY - minY);
}

export function rectContainsPoint(rect: Rect, point: Point): boolean {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

export function createDevicePixelRatio(value: number): DevicePixelRatio {
  return createScale<"DevicePixelRatio">(value, "devicePixelRatio");
}

export function createPageScaleFactor(value: number): PageScaleFactor {
  return createScale<"PageScaleFactor">(value, "pageScaleFactor");
}

export function createPageZoomFactor(value: number): PageZoomFactor {
  return createScale<"PageZoomFactor">(value, "pageZoomFactor");
}
