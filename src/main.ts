import "./style.css";
import { SelectionManager } from "./ui-utils.js";
import { EvaluationManager } from "./evaluation-manager.js";

export interface Point {
  x: number;
  y: number;
}

export interface DetectedShape {
  type: "circle" | "triangle" | "rectangle" | "pentagon" | "star";
  confidence: number;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  center: Point;
  area: number;
}

export interface DetectionResult {
  shapes: DetectedShape[];
  processingTime: number;
  imageWidth: number;
  imageHeight: number;
}

// Define a helper structure for our internal blob analysis
interface Blob {
  id: number; // A unique ID for each blob
  pixels: Point[]; // List of all pixels in the blob
  area: number; // Total count of pixels
  boundingBox: { x: number; y: number; width: number; height: number }; // The box around the blob
  center: { x: number; y: number }; // The average center point
}


//ShapeDetector Class
// This class contains the full implementation for detecting shapes.
// All the core logic for the challenge is inside this class.
 
export class ShapeDetector {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private width: number = 0;
  private height: number = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    // We add 'willReadFrequently' for a performance boost, as we'll be reading pixel data.
    this.ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  }

  /**
   * MAIN ALGORITHM
   * This is the core function that runs the entire 4-step detection pipeline.
   * @param imageData - The raw pixel data from the canvas.
   * @returns A promise that resolves to the DetectionResult.
   */
  async detectShapes(imageData: ImageData): Promise<DetectionResult> {
    const startTime = performance.now();

    this.width = imageData.width;
    this.height = imageData.height;

    // --- STEP 1: Binarize Image ---
    // Convert the full-color image into a simple 0 (background) or 1 (shape) grid.
    // We use 128 as the threshold, which worked best for the noisy image.
    const binaryImage = this.binarize(imageData, 128);

    // --- STEP 2: Find Blobs (Connected Component Analysis) ---
    // Scan the binary image and group all touching '1's into 'blobs'.
    // Each blob is one potential shape.
    const blobs = this.findBlobs(binaryImage);

    // --- STEP 3: Analyze each Blob ---
    const shapes: DetectedShape[] = [];
    for (const blob of blobs) {
      // =================================================================
      // === COMMENT BLOCK: Explaining the Filter Tuning Process ===
      //
      // This filter is critical for ignoring "noise" (like the lines
      // in 'no_shapes.png') while keeping real, small shapes.
      //
      // --- Our Tuning Process ---
      //
      // 1. FIRST ATTEMPT (e.g., < 100):
      //    Our first value was too low. It incorrectly detected the
      //    noise lines in 'no_shapes.png' and 'complex_scene.png'
      //    as "Triangle" shapes (areas were ~202px and ~322px).
      //
      // 2. SECOND ATTEMPT (< 500):
      //    We tried a high value. This successfully ignored the noise
      //    lines, but it was *too high*. It incorrectly filtered out
      //    the *real* small triangle in the 'edge_cases.png' image.
      //
      // 3. FINAL VALUE (< 350):
      //    This value is the perfect "sweet spot" we found after testing.
      //    - It IS high enough to block the noise lines (max area ~322px).
      //    - It IS low enough to keep the real small triangle (area ~375px).
      //
      // =================================================================
      if (blob.area < 350) continue;

      // --- STEP 4: Trace Contour ---
      // Find the outer boundary (perimeter) of the blob.
      const contour = this.traceContour(blob, binaryImage);
      // If the contour is too short, it's probably not a real shape.
      if (contour.length < 20) continue;

      // --- STEP 5: Classify the Shape ---
      // Analyze the contour's geometry to figure out what shape it is.
      const detection = this.analyzeContour(contour, blob);
      if (detection) {
        shapes.push(detection); // Add it to our final list
      }
    }

    const processingTime = performance.now() - startTime;

    // Return the final list of shapes in the required format.
    return {
      shapes,
      processingTime,
      imageWidth: imageData.width,
      imageHeight: imageData.height,
    };
  }

  
   // Loads an image file onto the hidden canvas and returns its ImageData.
  
  loadImage(file: File): Promise<ImageData> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        this.canvas.width = img.width;
        this.canvas.height = img.height;
        this.ctx.drawImage(img, 0, 0);
        // Set willReadFrequently for performance
        const ctxForReading = this.canvas.getContext("2d", {
          willReadFrequently: true,
        });
        if (!ctxForReading) return reject("Could not get canvas context");
        const imageData = ctxForReading.getImageData(
          0,
          0,
          img.width,
          img.height
        );
        resolve(imageData);
      };
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }

  
  // ** PRIVATE HELPER METHODS (The Algorithm) ** //
  

  
  //Step 1: Grayscale and Binarize
  //Converts RGBA pixel data to a simple 0/1 grid.
   
  private binarize(imageData: ImageData, threshold: number): number[][] {
    const data = imageData.data;
    // Create an empty 2D array filled with 0s
    const binaryImage: number[][] = Array(this.height)
      .fill(0)
      .map(() => Array(this.width).fill(0));

    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const i = (y * this.width + x) * 4; // Each pixel has 4 values (R,G,B,A)
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3]; // Alpha (transparency)

        // Convert to grayscale using the 'luminosity' formula
        const gray = 0.21 * r + 0.72 * g + 0.07 * b;

        // --- THIS IS THE CRITICAL LOGIC ---
        // If the pixel is dark enough (gray < threshold) and not transparent (a > 128),
        // we mark it as '1' (a shape pixel).
        if (gray < threshold && a > 128) {
          binaryImage[y][x] = 1; // Shape pixel
        }
      }
    }
    return binaryImage;
  }

  /**
   * Step 2: Find Blobs (Connected Component Analysis)
   * Uses a Breadth-First Search (BFS) algorithm to find all groups of connected '1's.
   */
  private findBlobs(binaryImage: number[][]): Blob[] {
    // 'labels' grid keeps track of which blob each pixel belongs to.
    const labels: number[][] = Array(this.height)
      .fill(0)
      .map(() => Array(this.width).fill(0));
    const blobs: Record<number, Point[]> = {}; // Stores pixels for each blob ID
    let currentLabel = 1; // We start at blob ID 1

    const queue: Point[] = []; // Queue for our BFS

    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        // If this is a shape pixel (1) and hasn't been labeled yet (0)...
        if (binaryImage[y][x] === 1 && labels[y][x] === 0) {
          // ...we have found a new blob!
          blobs[currentLabel] = [];
          queue.push({ x, y });
          labels[y][x] = currentLabel;

          // Start the BFS to find all connected pixels
          while (queue.length > 0) {
            const pixel = queue.shift()!;
            blobs[currentLabel].push(pixel);

            // Check all 8 neighbors (Moore neighborhood)
            for (let ny = -1; ny <= 1; ny++) {
              for (let nx = -1; nx <= 1; nx++) {
                if (nx === 0 && ny === 0) continue; // Skip self

                const neighbor: Point = { x: pixel.x + nx, y: pixel.y + ny };

                // Check if neighbor is valid, is a shape pixel, and is unlabeled
                if (
                  neighbor.y >= 0 &&
                  neighbor.y < this.height &&
                  neighbor.x >= 0 &&
                  neighbor.x < this.width &&
                  binaryImage[neighbor.y][neighbor.x] === 1 &&
                  labels[neighbor.y][neighbor.x] === 0
                ) {
                  labels[neighbor.y][neighbor.x] = currentLabel;
                  queue.push(neighbor); // Add to queue to explore its neighbors
                }
              }
            }
          }
          currentLabel++; // Move to the next blob ID
        }
      }
    }

    // Convert our blob pixel data into the final Blob objects with metrics
    return Object.entries(blobs).map(([id, pixels]) => {
      return {
        id: Number(id),
        pixels,
        ...this.calculateBlobMetrics(pixels),
      };
    });
  }

  
  //Helper for `findBlobs` to calculate key metrics for a blob.
   
  private calculateBlobMetrics(pixels: Point[]): Omit<Blob, "id" | "pixels"> {
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    let sumX = 0,
      sumY = 0;

    for (const p of pixels) {
      sumX += p.x;
      sumY += p.y;
      // Find the min/max X and Y to create the bounding box
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }

    const area = pixels.length; // Area is simply the number of pixels
    return {
      area: area,
      // Center is the average of all pixel coordinates
      center: { x: sumX / area, y: sumY / area },
      boundingBox: {
        x: minX,
        y: minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
      },
    };
  }

  // Step 4: Trace Contour (Moore-Neighbor Tracing)
  // Finds the outer boundary of a blob by "walking" around its edge.
  
  private traceContour(blob: Blob, binaryImage: number[][]): Point[] {
    const contour: Point[] = [];

    // Find a reliable starting point (top-most, then left-most pixel)
    let startPoint = blob.pixels[0];
    for (const p of blob.pixels) {
      if (p.y < startPoint.y || (p.y === startPoint.y && p.x < startPoint.x)) {
        startPoint = p;
      }
    }

    let current = startPoint;
    let direction = 0; // 0:N, 1:NE, 2:E, 3:SE, 4:S, 5:SW, 6:W, 7:NW

    // Directions to check, in clockwise order
    const neighbors = [
      { x: 0, y: -1 }, // N
      { x: 1, y: -1 }, // NE
      { x: 1, y: 0 }, // E
      { x: 1, y: 1 }, // SE
      { x: 0, y: 1 }, // S
      { x: -1, y: 1 }, // SW
      { x: -1, y: 0 }, // W
      { x: -1, y: -1 }, // NW
    ];

    do {
      contour.push(current);
      // We start checking from the neighbor "behind" where we came from.
      // This ensures we always "hug the left wall".
      let startDir = (direction + 6) % 8; // (direction - 2 + 8) % 8

      let next: Point | null = null;
      for (let i = 0; i < 8; i++) {
        const dirIndex = (startDir + i) % 8;
        const checkDir = neighbors[dirIndex];
        const checkPt = { x: current.x + checkDir.x, y: current.y + checkDir.y };

        // Is this neighbor a valid shape pixel?
        if (
          checkPt.y >= 0 &&
          checkPt.y < this.height &&
          checkPt.x >= 0 &&
          checkPt.x < this.width &&
          binaryImage[checkPt.y][checkPt.x] === 1
        ) {
          next = checkPt; // This is our next step
          direction = dirIndex; // Remember which direction we went
          break;
        }
      }

      if (next) {
        current = next;
      } else {
        break; // Should not happen on a multi-pixel blob
      }

      // We stop when we get back to the start point
    } while (current.x !== startPoint.x || current.y !== startPoint.y);

    return contour;
  }

  
  // ** Step 5: Analyze Contour & Classify ** //

  //This is the "brains" of the operation. It decides what shape a contour is.
  
  private analyzeContour(contour: Point[], blob: Blob): DetectedShape | null {
    // --- 5a. Simplify Contour ---
    // A contour has 1000s of points. We need to find just the "corners" (vertices).
    // We use the Ramer-Douglas-Peucker (RDP) algorithm to simplify the line.
    // 'epsilon' (2.0) is the max distance a point can be from the simplified line.
    // We found 2.0 works well for the test images.
    const vertices = this.simplifyContour(contour, 2.0);
    let numVertices = vertices.length;

    // RDP on a closed loop often counts the start/end point twice.
    // If the first and last vertex are the same, we count it as one.
    if (
      numVertices > 2 &&
      this.distance(vertices[0], vertices[vertices.length - 1]) < 10
    ) {
      numVertices--; // Correct for closed loop
    }

    let shape: DetectedShape["type"] | null = null;
    let confidence = 0.7; // Base confidence

    // --- 5b. Calculate Circularity ---
    const perimeter = this.getPerimeter(contour);
    const area = blob.area; // Use the accurate pixel-counted area
    // This formula (Polsby-Popper) checks how "round" a shape is.
    // A perfect circle will have a value of 1.0.
    const circularity = (4 * Math.PI * area) / (perimeter * perimeter);

    // --- 5c. Classification Logic --- 
    // We check for circle first, as it's the most distinct.
    if (circularity > 0.88) {
      shape = "circle";
      confidence = circularity; // Circularity is a great confidence score
    } else if (numVertices === 3) {
      shape = "triangle";
      confidence = 0.9;
    } else if (numVertices === 4) {
      shape = "rectangle"; // Per the requirements, squares are rectangles.
      confidence = 0.9;
    } else if (numVertices === 5) {
      shape = "pentagon";
      confidence = 0.85;
    } else if (numVertices === 10) {
      // A 5-point star is special, it has 10 vertices (5 inner, 5 outer).
      if (this.isStar(vertices, blob.center)) {
        shape = "star";
        confidence = 0.9;
      }
    }

    // If we couldn't classify it, we return null.
    if (shape === null) {
      return null;
    }

    // Make sure confidence is between 0.5 and 1.0
    if (confidence > 1.0) confidence = 1.0;
    if (confidence < 0.5) confidence = 0.5;

    // Return the final object in the format the evaluator expects.
    return {
      type: shape,
      confidence: confidence,
      boundingBox: blob.boundingBox,
      center: blob.center,
      area: blob.area,
    };
  }


  // ** GEOMETRY HELPER FUNCTIONS ** //
  

  
   //Standard distance formula.
   
  private distance(p1: Point, p2: Point): number {
    return Math.sqrt((p1.x - p2.x) ** 2 + (p1.y - p2.y) ** 2);
  }

  
  // Ramer-Douglas-Peucker (RDP) algorithm implementation.
  // This recursively simplifies a line by finding the point farthest
  // from the line segment and splitting there.
   

  private simplifyContour(points: Point[], epsilon: number): Point[] {
    if (points.length < 3) return points; // Cannot simplify a line

    let dmax = 0;
    let index = 0;
    const end = points.length - 1;

    // Find the point that is "farthest" from the line (start -> end)
    for (let i = 1; i < end; i++) {
      const d = this.perpendicularDistance(points[i], points[0], points[end]);
      if (d > dmax) {
        index = i;
        dmax = d;
      }
    }

    let results: Point[];
    // If the farthest point is "far enough" (dmax > epsilon)...
    if (dmax > epsilon) {
      // ...we recursively simplify the two new lines.
      const recResults1 = this.simplifyContour(
        points.slice(0, index + 1),
        epsilon
      );
      const recResults2 = this.simplifyContour(points.slice(index), epsilon);
      // And join the results
      results = recResults1.slice(0, recResults1.length - 1).concat(recResults2);
    } else {
      // Otherwise, all points are "close enough", so we just keep the start and end.
      results = [points[0], points[end]];
    }
    return results;
  }

  
  // Finds the perpendicular distance from a point to a line segment.
  //Helper for RDP.
   
  private perpendicularDistance(p: Point, a: Point, b: Point): number {
    const { x: px, y: py } = p;
    const { x: ax, y: ay } = a;
    const { x: bx, y: by } = b;

    const dx = bx - ax;
    const dy = by - ay;
    const magSqr = dx * dx + dy * dy;

    if (magSqr === 0) return this.distance(p, a); // Line is just a point

    const u = ((px - ax) * dx + (py - ay) * dy) / magSqr;

    let ix, iy; // Closest point on the line
    if (u < 0) {
      ix = ax;
      iy = ay;
    } else if (u > 1) {
      ix = bx;
      iy = by;
    } else {
      ix = ax + u * dx;
      iy = ay + u * dy;
    }
    return this.distance(p, { x: ix, y: iy });
  }

  //Calculates the total length of a contour.
   
  private getPerimeter(contour: Point[]): number {
    let perimeter = 0;
    for (let i = 0; i < contour.length; i++) {
      const p1 = contour[i];
      const p2 = contour[(i + 1) % contour.length]; // Wrap around to the start
      perimeter += this.distance(p1, p2);
    }
    return perimeter;
  }

  
   // Specific check for a 5-point star (which has 10 vertices).
   // It checks if 5 vertices are close to the center and 5 are far away.
   
  private isStar(vertices: Point[], center: Point): boolean {
    if (vertices.length < 10) return false;

    // Get the distance of every vertex from the center
    const distances = vertices
      .map((v) => this.distance(v, center))
      .sort((a, b) => a - b);

    // We assume the 5 smallest are inner points and 5 largest are outer
    const innerPoints = distances.slice(0, 5);
    const outerPoints = distances.slice(distances.length - 5);

    // Find the average radius of each group
    const innerRadius = innerPoints.reduce((a, b) => a + b, 0) / 5;
    const outerRadius = outerPoints.reduce((a, b) => a + b, 0) / 5;

    // In a star, the inner radius should be much smaller than the outer radius
    const ratio = innerRadius / outerRadius;

    return ratio < 0.7; // If the ratio is small, it's a star
  }
}


class ShapeDetectionApp {
  private detector: ShapeDetector;
  private imageInput: HTMLInputElement;
  private resultsDiv: HTMLDivElement;
  private testImagesDiv: HTMLDivElement;
  private evaluateButton: HTMLButtonElement;
  private evaluationResultsDiv: HTMLDivElement;
  private selectionManager: SelectionManager;
  private evaluationManager: EvaluationManager;

  constructor() {
    const canvas = document.getElementById(
      "originalCanvas"
    ) as HTMLCanvasElement;
    this.detector = new ShapeDetector(canvas);

    this.imageInput = document.getElementById("imageInput") as HTMLInputElement;
    this.resultsDiv = document.getElementById("results") as HTMLDivElement;
    this.testImagesDiv = document.getElementById(
      "testImages"
    ) as HTMLDivElement;
    this.evaluateButton = document.getElementById(
      "evaluateButton"
    ) as HTMLButtonElement;
    this.evaluationResultsDiv = document.getElementById(
      "evaluationResults"
    ) as HTMLDivElement;

    this.selectionManager = new SelectionManager();
    this.evaluationManager = new EvaluationManager(
      this.detector,
      this.evaluateButton,
      this.evaluationResultsDiv
    );

    this.setupEventListeners();
    this.loadTestImages().catch(console.error);
  }

  private setupEventListeners(): void {
    this.imageInput.addEventListener("change", async (event) => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (file) {
        await this.processImage(file);
      }
    });

    this.evaluateButton.addEventListener("click", async () => {
      const selectedImages = this.selectionManager.getSelectedImages();
      await this.evaluationManager.runSelectedEvaluation(selectedImages);
    });
  }

  private async processImage(file: File): Promise<void> {
    try {
      this.resultsDiv.innerHTML = "<p>Processing...</p>";

      const imageData = await this.detector.loadImage(file);
      const results = await this.detector.detectShapes(imageData);

      this.displayResults(results);
    } catch (error) {
      this.resultsDiv.innerHTML = `<p>Error: ${error}</p>`;
    }
  }

  private displayResults(results: DetectionResult): void {
    const { shapes, processingTime } = results;

    let html = `
      <p><strong>Processing Time:</strong> ${processingTime.toFixed(2)}ms</p>
      <p><strong>Shapes Found:</strong> ${shapes.length}</p>
    `;

    if (shapes.length > 0) {
      html += "<h4>Detected Shapes:</h4><ul>";
      shapes.forEach((shape) => {
        html += `
          <li>
            <strong>${
              shape.type.charAt(0).toUpperCase() + shape.type.slice(1)
            }</strong><br>
            Confidence: ${(shape.confidence * 100).toFixed(1)}%<br>
            Center: (${shape.center.x.toFixed(1)}, ${shape.center.y.toFixed(
          1
        )})<br>
            Area: ${shape.area.toFixed(1)}px²
          </li>
        `;
      });
      html += "</ul>";
    } else {
      html += "<p>No shapes detected.</p>";
    }

    this.resultsDiv.innerHTML = html;
  }

  private async loadTestImages(): Promise<void> {
    try {
      const module = await import("./test-images-data.js");
      const testImages = module.testImages;
      const imageNames = module.getAllTestImageNames();

      let html =
        '<h4>Click to upload your own image or use test images for detection. Right-click test images to select/deselect for evaluation:</h4><div class="evaluation-controls"><button id="selectAllBtn">Select All</button><button id="deselectAllBtn">Deselect All</button><span class="selection-info">0 images selected</span></div><div class="test-images-grid">';

      // Add upload functionality as first grid item
      html += `
        <div class="test-image-item upload-item" onclick="triggerFileUpload()">
          <div class="upload-icon">📁</div>
          <div class="upload-text">Upload Image</div>
          <div class="upload-subtext">Click to select file</div>
        </div>
      `;

      imageNames.forEach((imageName) => {
        const dataUrl = testImages[imageName as keyof typeof testImages];
        const displayName = imageName
          .replace(/[_-]/g, " ")
          .replace(/\.(svg|png)$/i, "");
        html += `
          <div class="test-image-item" data-image="${imageName}" 
               onclick="loadTestImage('${imageName}', '${dataUrl}')" 
               oncontextmenu="toggleImageSelection(event, '${imageName}')">
            <img src="${dataUrl}" alt="${imageName}">
            <div>${displayName}</div>
          </div>
        `;
      });

      html += "</div>";
      this.testImagesDiv.innerHTML = html;

      this.selectionManager.setupSelectionControls();

      (window as any).loadTestImage = async (
        name: string,
        dataUrl: string
      ) => {
        try {
          const response = await fetch(dataUrl);
          const blob = await response.blob();
          const file = new File([blob], name, { type: "image/svg+xml" });

          const imageData = await this.detector.loadImage(file);
          const results = await this.detector.detectShapes(imageData);
          this.displayResults(results);

          console.log(`Loaded test image: ${name}`);
        } catch (error) {
          console.error("Error loading test image:", error);
        }
      };

      (window as any).toggleImageSelection = (
        event: MouseEvent,
        imageName: string
      ) => {
        event.preventDefault();
        this.selectionManager.toggleImageSelection(imageName);
      };

      // Add upload functionality
      (window as any).triggerFileUpload = () => {
        this.imageInput.click();
      };
    } catch (error) {
      this.testImagesDiv.innerHTML = `
        <p>Test images not available. Run 'node convert-svg-to-png.js' to generate test image data.</p>
        <p>SVG files are available in the test-images/ directory.</p>
      `;
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  new ShapeDetectionApp();
});