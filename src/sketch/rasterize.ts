import { Resvg } from '@cf-wasm/resvg/workerd'

/**
 * Rasterize an SVG string to a PNG Uint8Array using resvg-wasm.
 * Uses the @cf-wasm/resvg wrapper which handles WASM init on CF Workers.
 */
export async function svgToPng(svg: string, width = 1200): Promise<Uint8Array> {
  const resvg = await Resvg.async(svg, {
    fitTo: { mode: 'width', value: width },
    background: '#ffffff',
  })
  const rendered = resvg.render()
  const png = rendered.asPng()
  rendered.free()
  resvg.free()
  return png
}
