// Minimal type shim for aladin-lite 3.8.2 (ESM-only, ships no types). Only what we use is typed;
// extend as needed. Checked against node_modules/aladin-lite/dist/aladin.js.

declare module "aladin-lite" {
  export type FrequencyUnit = "Hz" | "m" | "m/s";

  export interface HiPSOptions {
    name?: string;
    opacity?: number;
    imgFormat?: "png" | "jpeg" | "webp" | "fits";
    colormap?: string;
    stretch?: string;
    minCut?: number;
    maxCut?: number;
    successCallback?: (hips: HiPS) => void;
    errorCallback?: (error: unknown) => void;
  }

  export interface HiPS {
    readonly id: string;
    readonly url: string;
    readonly name: string;
    /** Set once the layer is attached to a view. setFrequency/setSliceNumber are no-ops before. */
    readonly added: boolean;
    readonly cubeDepth?: number;
    readonly emMin?: number;
    readonly emMax?: number;
    setOpacity(opacity: number): void;
    getOpacity(): number;
    setOptions(options: Partial<HiPSOptions> & Record<string, unknown>): void;
    toggle(): void;
    isSpectralCube(): boolean;
    /** Preferred way to pick a cube frame (see src/lib/spherex.ts). */
    setFrequency(frequency: { value: number; unit: FrequencyUnit; restFreq?: number }): void;
    getFrequency(): number | undefined;
    /** Linear in wavelength, which picks the wrong SPHEREx frames. Do not use. */
    setSliceNumber(slice: number): void;
  }

  export interface AladinOptions {
    survey?: string | HiPS | Array<string | HiPS>;
    hipsList?: unknown[];
    target?: string;
    fov?: number;
    projection?: "SIN" | "TAN" | "STG" | "ZEA" | "FEYE" | "AIR" | "ARC" | "NCP" | "MER" | "CAR" | "CEA" | "CYP" | "AIT" | "MOL" | "PAR" | "SFL" | "COD" | "HPX";
    cooFrame?: "ICRS" | "ICRSd" | "GAL" | "galactic" | "equatorial" | (string & {});
    backgroundColor?: string;
    log?: boolean;
    samp?: boolean;
    inertia?: boolean;
    mode?: "dark" | "light";
    showReticle?: boolean;
    showZoomControl?: boolean;
    showLayersControl?: boolean;
    showFullscreenControl?: boolean;
    showSimbadPointerControl?: boolean;
    showCooGridControl?: boolean;
    showSettingsControl?: boolean;
    showShareControl?: boolean;
    showColorPickerControl?: boolean;
    showFrame?: boolean;
    showFov?: boolean;
    showCooLocation?: boolean;
    showProjectionControl?: boolean;
    showStatusBar?: boolean;
    showContextMenu?: boolean;
    showCatalog?: boolean;
    fullScreen?: boolean;
    pixelateCanvas?: boolean;
  }

  export interface PositionChangedEvent {
    ra: number;
    dec: number;
    dragging: boolean;
    frame: string;
  }

  export interface Aladin {
    setBaseImageLayer(layer: HiPS | string): HiPS;
    getBaseImageLayer(): HiPS | undefined;
    setOverlayImageLayer(layer: HiPS | string, name?: string): HiPS;
    getOverlayImageLayer(name: string): HiPS | undefined;
    removeImageLayer(name: string): void;
    gotoRaDec(ra: number, dec: number): void;
    setFoV(fovDeg: number): void;
    /** [ra, dec] in degrees, in the current coordinate frame. */
    getRaDec(): [number, number];
    /** [fovX, fovY] in degrees. */
    getFov(): [number, number];
    on(event: "positionChanged", callback: (event: PositionChangedEvent) => void): void;
    on(event: "zoomChanged", callback: (fovDeg: number) => void): void;
    on(event: string, callback: (...args: never[]) => void): void;
  }

  interface AladinStatic {
    /** Resolves once the WebAssembly core is loaded. Rejects without WebGL2. */
    readonly init: Promise<void>;
    aladin(element: HTMLElement | string, options?: AladinOptions): Aladin;
    HiPS(urlOrId: string, options?: HiPSOptions): HiPS;
    imageHiPS(urlOrId: string, options?: HiPSOptions): HiPS;
  }

  const A: AladinStatic;
  export default A;
}
