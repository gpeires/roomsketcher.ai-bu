import { chromium } from 'playwright';

const sketches = [
  { id: 'JusWGgeipj0ODRWkclXXv', name: 'studio' },
  { id: 'RVjAAi0u05J88Cf4isKWB', name: '1br' },
  { id: 'XSJNi2RhlF5Lgb9BH1LkR', name: '2br' },
  { id: 'adI358Up8KM8DLBgfHosE', name: '3br' },
  { id: 'DXOThFKlF0-Mj9yMdc7Sx', name: 'loft' },
  { id: 'RQAsAMbPVRRoUKTw5Td2o', name: 'lshaped' },
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });

for (const s of sketches) {
  const url = `https://roomsketcher.kworq.com/sketcher/${s.id}`;
  console.log(`Capturing ${s.name}...`);
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  // Wait a bit for SVG rendering to complete
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `/tmp/sketch_${s.name}.png`, fullPage: false });
  console.log(`  Saved /tmp/sketch_${s.name}.png`);
}

await browser.close();
console.log('Done!');
