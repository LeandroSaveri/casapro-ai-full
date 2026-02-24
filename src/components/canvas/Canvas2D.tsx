import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { useProjectStore } from '@/store/projectStore';
import { useUIStore } from '@/store/uiStore';
import type { Point, Wall, Room } from '@/types';
import { 
  MousePointer2, 
  Square, 
  DoorOpen, 
  SquareIcon, 
  Armchair,
  Grid3X3,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Check,
  X,
  ChevronRight,
  Trash2,
  Copy,
  Move
} from 'lucide-react';

// ============ CONFIGURAÇÕES MAGICPLAN STYLE ============

const COLORS = {
  background: '#f5f5f5',
  grid: '#e0e0e0',
  gridMajor: '#d0d0d0',
  axis: '#999999',
  wall: '#ffffff',
  wallBorder: '#333333',
  wallSelected: '#4a90d9',
  roomFill: ['#e8f4f8', '#f0e8f8', '#e8f8e8', '#f8f0e8', '#f8e8e8', '#e8f0f8'],
  door: '#8B4513',
  window: '#87CEEB',
  furniture: '#666666',
  text: '#333333',
  textLight: '#666666',
  snapPoint: '#4a90d9',
  preview: '#4a90d9',
  measurement: '#333333',
};

const SNAP_THRESHOLD = 15; // pixels
const CORNER_SNAP_THRESHOLD = 20;
const PARALLEL_SNAP_THRESHOLD = 10;
const MIN_WALL_LENGTH = 0.1; // metros

interface SnapResult {
  point: Point;
  type: 'none' | 'endpoint' | 'corner' | 'grid' | 'parallel' | 'perpendicular' | 'extension';
  source?: Wall;
  angle?: number;
}

interface DrawingState {
  isDrawing: boolean;
  points: Point[];
  currentWall: { start: Point; end: Point } | null;
}

const Canvas2D: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  // Estados de navegação
  const [scale, setScale] = useState(25); // pixels por metro
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState<Point>({ x: 0, y: 0 });
  
  // Estados de desenho estilo MagicPlan
  const [drawingState, setDrawingState] = useState<DrawingState>({
    isDrawing: false,
    points: [],
    currentWall: null,
  });
  
  // Ferramenta ativa
  const [activeTool, setActiveTool] = useState<'select' | 'wall' | 'room' | 'door' | 'window' | 'furniture'>('select');
  
  // Snap e hover
  const [snapResult, setSnapResult] = useState<SnapResult | null>(null);
  const [hoveredElement, setHoveredElement] = useState<{ id: string; type: string } | null>(null);
  const [mousePos, setMousePos] = useState<Point>({ x: 0, y: 0 });
  
  // UI states
  const [showGrid, setShowGrid] = useState(true);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [showMeasurements, setShowMeasurements] = useState(true);
  
  // Dados do projeto
  const { currentProject, addWall, updateWall, deleteWall, addRoom, selectElement, selectedElement, selectedElementType } = useProjectStore();

  // ============ COORDENADAS ============
  
  const worldToCanvas = useCallback((point: Point): Point => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    return {
      x: point.x * scale + canvas.width / 2 + offset.x,
      y: -point.y * scale + canvas.height / 2 + offset.y,
    };
  }, [scale, offset]);

  const canvasToWorld = useCallback((point: Point): Point => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    return {
      x: (point.x - canvas.width / 2 - offset.x) / scale,
      y: -(point.y - canvas.height / 2 - offset.y) / scale,
    };
  }, [scale, offset]);

  const getCanvasPoint = useCallback((e: React.PointerEvent | PointerEvent): Point | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }, []);

  // ============ SNAP INTELIGENTE MAGICPLAN ============

  const distance = (a: Point, b: Point): number => {
    return Math.sqrt(Math.pow(a.x - b.x, 2) + Math.pow(a.y - b.y, 2));
  };

  const distanceToLineSegment = (point: Point, start: Point, end: Point): number => {
    const l2 = Math.pow(start.x - end.x, 2) + Math.pow(start.y - end.y, 2);
    if (l2 === 0) return distance(point, start);
    let t = ((point.x - start.x) * (end.x - start.x) + (point.y - start.y) * (end.y - start.y)) / l2;
    t = Math.max(0, Math.min(1, t));
    const projection = {
      x: start.x + t * (end.x - start.x),
      y: start.y + t * (end.y - start.y),
    };
    return distance(point, projection);
  };

  const projectPointOnLine = (point: Point, start: Point, end: Point): Point => {
    const l2 = Math.pow(start.x - end.x, 2) + Math.pow(start.y - end.y, 2);
    if (l2 === 0) return start;
    const t = Math.max(0, Math.min(1, ((point.x - start.x) * (end.x - start.x) + (point.y - start.y) * (end.y - start.y)) / l2));
    return {
      x: start.x + t * (end.x - start.x),
      y: start.y + t * (end.y - start.y),
    };
  };

  const getWallAngle = (wall: Wall): number => {
    return Math.atan2(wall.end.y - wall.start.y, wall.end.x - wall.start.x);
  };

  const findSnapPoint = useCallback((worldPoint: Point, excludeWallId?: string): SnapResult => {
    if (!snapEnabled || !currentProject) {
      return { point: worldPoint, type: 'none' };
    }

    const canvasPoint = worldToCanvas(worldPoint);
    let bestSnap: SnapResult = { point: worldPoint, type: 'none' };
    let bestDistance = SNAP_THRESHOLD / scale; // em metros

    // 1. Snap para endpoints de paredes (cantos)
    for (const wall of currentProject.walls) {
      if (wall.id === excludeWallId) continue;
      
      const startDist = distance(worldPoint, wall.start);
      const endDist = distance(worldPoint, wall.end);
      
      if (startDist < bestDistance) {
        bestDistance = startDist;
        bestSnap = { point: wall.start, type: 'corner', source: wall };
      }
      if (endDist < bestDistance) {
        bestDistance = endDist;
        bestSnap = { point: wall.end, type: 'corner', source: wall };
      }
    }

    // 2. Snap para linha de parede (perpendicular)
    for (const wall of currentProject.walls) {
      if (wall.id === excludeWallId) continue;
      
      const proj = projectPointOnLine(worldPoint, wall.start, wall.end);
      const dist = distance(worldPoint, proj);
      
      if (dist < bestDistance && dist < 0.3) { // máximo 30cm da parede
        bestDistance = dist;
        bestSnap = { point: proj, type: 'extension', source: wall };
      }
    }

    // 3. Snap para paralelo (alinhar com parede existente)
    if (drawingState.currentWall) {
      const currentAngle = Math.atan2(
        worldPoint.y - drawingState.currentWall.start.y,
        worldPoint.x - drawingState.currentWall.start.x
      );
      
      for (const wall of currentProject.walls) {
        const wallAngle = getWallAngle(wall);
        const angleDiff = Math.abs(currentAngle - wallAngle);
        const normalizedDiff = Math.min(angleDiff, Math.PI * 2 - angleDiff);
        
        if (normalizedDiff < 0.1 || Math.abs(normalizedDiff - Math.PI) < 0.1) { // ~5 graus
          // Calcular ponto alinhado paralelo
          const dist = distance(drawingState.currentWall.start, worldPoint);
          const parallelAngle = Math.abs(normalizedDiff - Math.PI) < 0.1 ? wallAngle + Math.PI : wallAngle;
          const alignedPoint = {
            x: drawingState.currentWall.start.x + Math.cos(parallelAngle) * dist,
            y: drawingState.currentWall.start.y + Math.sin(parallelAngle) * dist,
          };
          
          const alignedCanvas = worldToCanvas(alignedPoint);
          const currentCanvas = worldToCanvas(worldPoint);
          const pixelDiff = Math.sqrt(
            Math.pow(alignedCanvas.x - currentCanvas.x, 2) + 
            Math.pow(alignedCanvas.y - currentCanvas.y, 2)
          );
          
          if (pixelDiff < PARALLEL_SNAP_THRESHOLD) {
            bestSnap = { 
              point: alignedPoint, 
              type: 'parallel', 
              source: wall,
              angle: parallelAngle * 180 / Math.PI 
            };
            break;
          }
        }
      }
    }

    // 4. Snap perpendicular (ângulos retos)
    if (drawingState.points.length > 0) {
      const lastPoint = drawingState.points[drawingState.points.length - 1];
      const prevPoint = drawingState.points.length > 1 
        ? drawingState.points[drawingState.points.length - 2] 
        : null;
      
      if (prevPoint) {
        const lastAngle = Math.atan2(lastPoint.y - prevPoint.y, lastPoint.x - prevPoint.x);
        const currentAngle = Math.atan2(worldPoint.y - lastPoint.y, worldPoint.x - lastPoint.x);
        const angleDiff = Math.abs(currentAngle - lastAngle);
        const normalizedDiff = Math.min(angleDiff, Math.PI * 2 - angleDiff);
        
        // Se está perto de 90 graus
        if (Math.abs(normalizedDiff - Math.PI / 2) < 0.15) {
          const dist = distance(lastPoint, worldPoint);
          const perpAngle = lastAngle + Math.PI / 2;
          const perpPoint = {
            x: lastPoint.x + Math.cos(perpAngle) * dist,
            y: lastPoint.y + Math.sin(perpAngle) * dist,
          };
          
          bestSnap = { point: perpPoint, type: 'perpendicular', angle: 90 };
        }
      }
    }

    // 5. Snap para grid
    const gridSize = 0.5; // 50cm
    const gridPoint = {
      x: Math.round(worldPoint.x / gridSize) * gridSize,
      y: Math.round(worldPoint.y / gridSize) * gridSize,
    };
    const gridDist = distance(worldPoint, gridPoint);
    if (gridDist < bestDistance && gridDist < 0.15) {
      bestSnap = { point: gridPoint, type: 'grid' };
    }

    return bestSnap;
  }, [currentProject, snapEnabled, drawingState, worldToCanvas]);

  // ============ DETECÇÃO DE CÔMODOS ============

  const detectRooms = useCallback((): Room[] => {
    if (!currentProject) return [];
    
    // Algoritmo simplificado: encontrar ciclos no grafo de paredes
    const walls = currentProject.walls;
    const rooms: Room[] = [];
    
    // Para cada parede, tentar encontrar ciclos fechados
    const visited = new Set<string>();
    
    const findCycles = (startWall: Wall, startPoint: Point, path: Wall[], pathPoints: Point[]): void => {
      if (path.length > 20) return; // Limite de profundidade
      
      const lastPoint = pathPoints[pathPoints.length - 1];
      
      // Verificar se fechou o ciclo
      if (path.length >= 3 && distance(lastPoint, startPoint) < 0.1) {
        // Calcular área do polígono
        const area = calculatePolygonArea(pathPoints);
        if (area > 0.5) { // Mínimo 0.5m²
          const roomId = `room-${Date.now()}-${Math.random()}`;
          rooms.push({
            id: roomId,
            name: `Cômodo ${rooms.length + 1}`,
            points: [...pathPoints],
            area: Math.abs(area),
            color: COLORS.roomFill[rooms.length % COLORS.roomFill.length],
            height: 2.8,
            floorMaterial: 'ceramic',
            wallMaterial: 'plaster',
          });
        }
        return;
      }
      
      // Continuar busca
      for (const wall of walls) {
        if (path.includes(wall)) continue;
        
        const connects = distance(lastPoint, wall.start) < 0.1 || distance(lastPoint, wall.end) < 0.1;
        if (connects) {
          const nextPoint = distance(lastPoint, wall.start) < 0.1 ? wall.end : wall.start;
          findCycles(startWall, startPoint, [...path, wall], [...pathPoints, nextPoint]);
        }
      }
    };
    
    for (const wall of walls) {
      findCycles(wall, wall.start, [wall], [wall.start, wall.end]);
    }
    
    return rooms;
  }, [currentProject]);

  const calculatePolygonArea = (points: Point[]): number => {
    if (points.length < 3) return 0;
    let area = 0;
    for (let i = 0; i < points.length; i++) {
      const j = (i + 1) % points.length;
      area += points[i].x * points[j].y;
      area -= points[j].x * points[i].y;
    }
    return Math.abs(area) / 2;
  };

  // ============ HANDLERS DE DESENHO MAGICPLAN ============

  const startDrawing = useCallback((point: Point) => {
    const snapped = findSnapPoint(point);
    
    setDrawingState(prev => ({
      ...prev,
      isDrawing: true,
      points: [snapped.point],
      currentWall: { start: snapped.point, end: snapped.point },
    }));
  }, [findSnapPoint]);

  const updateDrawing = useCallback((point: Point) => {
    if (!drawingState.isDrawing || drawingState.points.length === 0) return;
    
    const snapped = findSnapPoint(point);
    const lastPoint = drawingState.points[drawingState.points.length - 1];
    
    // Atualizar parede atual
    setDrawingState(prev => ({
      ...prev,
      currentWall: { start: lastPoint, end: snapped.point },
    }));
    
    setSnapResult(snapped);
  }, [drawingState.isDrawing, drawingState.points, findSnapPoint]);

  const addCurrentWall = useCallback(() => {
    if (!drawingState.currentWall) return;
    
    const wallLength = distance(drawingState.currentWall.start, drawingState.currentWall.end);
    if (wallLength < MIN_WALL_LENGTH) return;
    
    // Verificar se já existe parede idêntica
    const exists = currentProject?.walls.some(w => 
      (distance(w.start, drawingState.currentWall!.start) < 0.01 && 
       distance(w.end, drawingState.currentWall!.end) < 0.01) ||
      (distance(w.start, drawingState.currentWall!.end) < 0.01 && 
       distance(w.end, drawingState.currentWall!.start) < 0.01)
    );
    
    if (!exists) {
      addWall({
        start: drawingState.currentWall.start,
        end: drawingState.currentWall.end,
        thickness: 0.15,
        height: 2.8,
        color: COLORS.wallBorder,
      });
    }
  }, [drawingState.currentWall, currentProject?.walls, addWall]);

  const continueDrawing = useCallback((point: Point) => {
    if (!drawingState.isDrawing) return;
    
    const snapped = findSnapPoint(point);
    
    // Adicionar parede atual
    addCurrentWall();
    
    // Verificar se fechou um cômodo (voltou próximo ao ponto inicial)
    const firstPoint = drawingState.points[0];
    const closedRoom = distance(snapped.point, firstPoint) < 0.3 && drawingState.points.length >= 3;
    
    if (closedRoom) {
      // Fechar o cômodo
      addWall({
        start: drawingState.currentWall!.start,
        end: firstPoint,
        thickness: 0.15,
        height: 2.8,
        color: COLORS.wallBorder,
      });
      
      // Detectar e adicionar cômodo
      const rooms = detectRooms();
      if (rooms.length > 0) {
        const newRoom = rooms[rooms.length - 1];
        addRoom({
          name: newRoom.name,
          points: newRoom.points,
          color: newRoom.color,
          height: 2.8,
          floorMaterial: 'ceramic',
          wallMaterial: 'plaster',
        });
      }
      
      // Finalizar desenho
      setDrawingState({
        isDrawing: false,
        points: [],
        currentWall: null,
      });
    } else {
      // Continuar desenhando
      setDrawingState(prev => ({
        ...prev,
        points: [...prev.points, snapped.point],
        currentWall: { start: snapped.point, end: snapped.point },
      }));
    }
  }, [drawingState, findSnapPoint, addCurrentWall, addWall, addRoom, detectRooms]);

  const cancelDrawing = useCallback(() => {
    setDrawingState({
      isDrawing: false,
      points: [],
      currentWall: null,
    });
    setSnapResult(null);
  }, []);

  // ============ RENDERIZAÇÃO ============

  const drawGrid = (ctx: CanvasRenderingContext2D, width: number, height: number) => {
    if (!showGrid) return;
    
    const gridSizeM = 0.5; // 50cm
    const gridSizePx = gridSizeM * scale;
    
    const startX = (offset.x % gridSizePx + gridSizePx) % gridSizePx;
    const startY = (offset.y % gridSizePx + gridSizePx) % gridSizePx;
    
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    
    for (let x = startX; x < width; x += gridSizePx) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
    }
    for (let y = startY; y < height; y += gridSizePx) {
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    }
    ctx.stroke();
    
    // Grid maior (a cada 2m)
    const majorGridSizePx = gridSizePx * 4;
    const majorStartX = (offset.x % majorGridSizePx + majorGridSizePx) % majorGridSizePx;
    const majorStartY = (offset.y % majorGridSizePx + majorGridSizePx) % majorGridSizePx;
    
    ctx.strokeStyle = COLORS.gridMajor;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    
    for (let x = majorStartX; x < width; x += majorGridSizePx) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
    }
    for (let y = majorStartY; y < height; y += majorGridSizePx) {
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    }
    ctx.stroke();
    
    // Eixos centrais
    const centerX = width / 2 + offset.x;
    const centerY = height / 2 + offset.y;
    
    ctx.strokeStyle = COLORS.axis;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(centerX, 0);
    ctx.lineTo(centerX, height);
    ctx.moveTo(0, centerY);
    ctx.lineTo(width, centerY);
    ctx.stroke();
  };

  const drawWall = (ctx: CanvasRenderingContext2D, wall: Wall, isSelected: boolean, isPreview: boolean = false) => {
    const start = worldToCanvas(wall.start);
    const end = worldToCanvas(wall.end);
    
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    
    if (length === 0) return;
    
    const thickness = Math.max(wall.thickness * scale, 3);
    const perpX = (-dy / length) * thickness / 2;
    const perpY = (dx / length) * thickness / 2;
    
    // Preenchimento da parede
    ctx.fillStyle = isSelected ? COLORS.wallSelected : (isPreview ? COLORS.preview : COLORS.wall);
    ctx.beginPath();
    ctx.moveTo(start.x + perpX, start.y + perpY);
    ctx.lineTo(end.x + perpX, end.y + perpY);
    ctx.lineTo(end.x - perpX, end.y - perpY);
    ctx.lineTo(start.x - perpX, start.y - perpY);
    ctx.closePath();
    ctx.fill();
    
    // Borda
    ctx.strokeStyle = isSelected ? '#2a5a9a' : COLORS.wallBorder;
    ctx.lineWidth = isSelected ? 2 : 1.5;
    ctx.stroke();
    
    // Medidas
    if (showMeasurements && !isPreview) {
      const wallLengthM = Math.sqrt(
        Math.pow(wall.end.x - wall.start.x, 2) + 
        Math.pow(wall.end.y - wall.start.y, 2)
      );
      
      const midX = (start.x + end.x) / 2;
      const midY = (start.y + end.y) / 2;
      
      ctx.save();
      ctx.translate(midX, midY);
      ctx.rotate(Math.atan2(dy, dx));
      
      // Fundo da medida
      const text = `${wallLengthM.toFixed(2)}m`;
      ctx.font = 'bold 11px Inter, system-ui, sans-serif';
      const textWidth = ctx.measureText(text).width;
      
      ctx.fillStyle = 'rgba(245, 245, 245, 0.9)';
      ctx.fillRect(-textWidth / 2 - 4, -20, textWidth + 8, 16);
      
      // Texto
      ctx.fillStyle = COLORS.measurement;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 0, -12);
      
      ctx.restore();
    }
  };

  const drawRoom = (ctx: CanvasRenderingContext2D, room: Room, isSelected: boolean) => {
    if (room.points.length < 3) return;
    
    const canvasPoints = room.points.map(p => worldToCanvas(p));
    
    // Preenchimento
    ctx.fillStyle = isSelected ? room.color : room.color + '80';
    ctx.beginPath();
    ctx.moveTo(canvasPoints[0].x, canvasPoints[0].y);
    for (let i = 1; i < canvasPoints.length; i++) {
      ctx.lineTo(canvasPoints[i].x, canvasPoints[i].y);
    }
    ctx.closePath();
    ctx.fill();
    
    // Borda
    ctx.strokeStyle = isSelected ? COLORS.wallSelected : COLORS.wallBorder;
    ctx.lineWidth = isSelected ? 2 : 1;
    ctx.stroke();
    
    // Nome e área
    const centroid = room.points.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
    centroid.x /= room.points.length;
    centroid.y /= room.points.length;
    const center = worldToCanvas(centroid);
    
    ctx.fillStyle = COLORS.text;
    ctx.font = 'bold 13px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(room.name, center.x, center.y - 2);
    
    ctx.font = '11px Inter, system-ui, sans-serif';
    ctx.fillStyle = COLORS.textLight;
    ctx.textBaseline = 'top';
    ctx.fillText(`${room.area.toFixed(1)}m²`, center.x, center.y + 2);
  };

  const drawDoor = (ctx: CanvasRenderingContext2D, door: any, isSelected: boolean) => {
    const wall = currentProject?.walls.find(w => w.id === door.wallId);
    if (!wall) return;
    
    const start = worldToCanvas(wall.start);
    const end = worldToCanvas(wall.end);
    const t = door.position;
    
    const x = start.x + (end.x - start.x) * t;
    const y = start.y + (end.y - start.y) * t;
    const doorWidthPx = door.width * scale;
    
    // Arco de abertura
    ctx.strokeStyle = isSelected ? COLORS.wallSelected : COLORS.door;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, doorWidthPx / 2, 0, Math.PI / 2);
    ctx.stroke();
    
    // Folha da porta
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + doorWidthPx / 2, y);
    ctx.stroke();
    
    // Batente
    ctx.fillStyle = COLORS.door;
    ctx.fillRect(x - 3, y - 3, 6, 6);
  };

  const drawWindow = (ctx: CanvasRenderingContext2D, window: any, isSelected: boolean) => {
    const wall = currentProject?.walls.find(w => w.id === window.wallId);
    if (!wall) return;
    
    const start = worldToCanvas(wall.start);
    const end = worldToCanvas(wall.end);
    const t = window.position;
    
    const x = start.x + (end.x - start.x) * t;
    const y = start.y + (end.y - start.y) * t;
    const windowWidthPx = window.width * scale;
    
    // Moldura
    ctx.strokeStyle = isSelected ? COLORS.wallSelected : COLORS.window;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x - windowWidthPx / 2, y - 4);
    ctx.lineTo(x + windowWidthPx / 2, y - 4);
    ctx.moveTo(x - windowWidthPx / 2, y + 4);
    ctx.lineTo(x + windowWidthPx / 2, y + 4);
    ctx.stroke();
    
    // Vidro
    ctx.fillStyle = 'rgba(135, 206, 235, 0.4)';
    ctx.fillRect(x - windowWidthPx / 2, y - 4, windowWidthPx, 8);
  };

  const drawFurniture = (ctx: CanvasRenderingContext2D, furniture: any, isSelected: boolean) => {
    const pos = worldToCanvas(furniture.position);
    const width = furniture.scale.x * scale;
    const depth = furniture.scale.y * scale;
    
    ctx.save();
    ctx.translate(pos.x, pos.y);
    ctx.rotate(-furniture.rotation);
    
    // Corpo
    ctx.fillStyle = isSelected ? 'rgba(74, 144, 217, 0.3)' : 'rgba(102, 102, 102, 0.2)';
    ctx.strokeStyle = isSelected ? COLORS.wallSelected : COLORS.furniture;
    ctx.lineWidth = isSelected ? 2 : 1;
    
    ctx.fillRect(-width / 2, -depth / 2, width, depth);
    ctx.strokeRect(-width / 2, -depth / 2, width, depth);
    
    // Nome
    ctx.fillStyle = COLORS.text;
    ctx.font = '9px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(furniture.name, 0, 0);
    
    ctx.restore();
  };

  const drawSnapIndicator = (ctx: CanvasRenderingContext2D) => {
    if (!snapResult || snapResult.type === 'none') return;
    
    const point = worldToCanvas(snapResult.point);
    
    // Círculo externo
    ctx.strokeStyle = COLORS.snapPoint;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(point.x, point.y, 10, 0, Math.PI * 2);
    ctx.stroke();
    
    // Cruz
    ctx.beginPath();
    ctx.moveTo(point.x - 14, point.y);
    ctx.lineTo(point.x + 14, point.y);
    ctx.moveTo(point.x, point.y - 14);
    ctx.lineTo(point.x, point.y + 14);
    ctx.stroke();
    
    // Ponto central
    ctx.fillStyle = COLORS.snapPoint;
    ctx.beginPath();
    ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
    ctx.fill();
    
    // Label do tipo de snap
    ctx.fillStyle = COLORS.snapPoint;
    ctx.font = 'bold 10px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(snapResult.type.toUpperCase(), point.x, point.y - 20);
  };

  const drawPreview = (ctx: CanvasRenderingContext2D) => {
    if (!drawingState.isDrawing || !drawingState.currentWall) return;
    
    // Desenhar parede em preview
    drawWall(ctx, {
      ...drawingState.currentWall,
      thickness: 0.15,
      height: 2.8,
      color: COLORS.preview,
      id: 'preview',
    } as Wall, false, true);
    
    // Desenhar linha tracejada
    const start = worldToCanvas(drawingState.currentWall.start);
    const end = worldToCanvas(drawingState.currentWall.end);
    
    ctx.strokeStyle = COLORS.preview;
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 4]);
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.stroke();
    ctx.setLineDash([]);
    
    // Medida em tempo real
    const dist = distance(drawingState.currentWall.start, drawingState.currentWall.end);
    const midX = (start.x + end.x) / 2;
    const midY = (start.y + end.y) / 2;
    
    ctx.fillStyle = COLORS.preview;
    ctx.font = 'bold 14px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${dist.toFixed(2)}m`, midX, midY - 25);
    
    // Ângulo
    const angle = Math.atan2(
      drawingState.currentWall.end.y - drawingState.currentWall.start.y,
      drawingState.currentWall.end.x - drawingState.currentWall.start.x
    ) * 180 / Math.PI;
    
    ctx.font = '12px Inter, system-ui, sans-serif';
    ctx.fillText(`${angle.toFixed(0)}°`, start.x, start.y - 20);
    
    // Desenhar pontos anteriores
    ctx.fillStyle = COLORS.snapPoint;
    drawingState.points.forEach((p, i) => {
      const cp = worldToCanvas(p);
      ctx.beginPath();
      ctx.arc(cp.x, cp.y, i === 0 ? 6 : 4, 0, Math.PI * 2);
      ctx.fill();
    });
  };

  // ============ MAIN RENDER ============

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    // Fundo
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Grid
    drawGrid(ctx, canvas.width, canvas.height);
    
    if (!currentProject) return;
    
    // Cômodos (atrás das paredes)
    currentProject.rooms.forEach(room => {
      drawRoom(ctx, room, selectedElement === room.id && selectedElementType === 'room');
    });
    
    // Paredes
    currentProject.walls.forEach(wall => {
      drawWall(ctx, wall, selectedElement === wall.id && selectedElementType === 'wall');
    });
    
    // Portas
    currentProject.doors.forEach(door => {
      drawDoor(ctx, door, selectedElement === door.id && selectedElementType === 'door');
    });
    
    // Janelas
    currentProject.windows.forEach(window => {
      drawWindow(ctx, window, selectedElement === window.id && selectedElementType === 'window');
    });
    
    // Móveis
    currentProject.furniture.forEach(furniture => {
      drawFurniture(ctx, furniture, selectedElement === furniture.id && selectedElementType === 'furniture');
    });
    
    // Preview e snap
    drawPreview(ctx);
    drawSnapIndicator(ctx);
  });

  // ============ EVENT HANDLERS ============

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(e.pointerId);
    
    const canvasPoint = getCanvasPoint(e);
    if (!canvasPoint) return;
    
    const worldPoint = canvasToWorld(canvasPoint);
    
    // Pan com middle click ou Alt
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      setIsPanning(true);
      setPanStart(canvasPoint);
      return;
    }
    
    // Desenho de parede
    if (activeTool === 'wall' && e.button === 0) {
      if (!drawingState.isDrawing) {
        startDrawing(worldPoint);
      } else {
        continueDrawing(worldPoint);
      }
      return;
    }
    
    // Seleção
    if (activeTool === 'select') {
      selectElement(null);
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    e.preventDefault();
    
    const canvasPoint = getCanvasPoint(e);
    if (!canvasPoint) return;
    
    setMousePos(canvasPoint);
    const worldPoint = canvasToWorld(canvasPoint);
    
    // Pan
    if (isPanning) {
      const dx = canvasPoint.x - panStart.x;
      const dy = canvasPoint.y - panStart.y;
      setOffset(prev => ({ x: prev.x + dx, y: prev.y + dy }));
      setPanStart(canvasPoint);
      return;
    }
    
    // Update desenho
    if (drawingState.isDrawing) {
      updateDrawing(worldPoint);
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    e.preventDefault();
    
    const canvas = canvasRef.current;
    if (canvas) {
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {}
    }
    
    if (isPanning) {
      setIsPanning(false);
    }
  };

  const handleDoubleClick = () => {
    // Finalizar desenho com double click
    if (drawingState.isDrawing) {
      cancelDrawing();
    }
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setScale(prev => Math.max(5, Math.min(200, prev * delta)));
  };

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape' && drawingState.isDrawing) {
      cancelDrawing();
    }
    if (e.key === 'Delete' && selectedElement) {
      // Implementar deleção
    }
  }, [drawingState.isDrawing, selectedElement, cancelDrawing]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Resize
  useEffect(() => {
    const handleResize = () => {
      if (containerRef.current && canvasRef.current) {
        canvasRef.current.width = containerRef.current.clientWidth;
        canvasRef.current.height = containerRef.current.clientHeight;
      }
    };
    
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // ============ UI ============

  const ToolButton = ({ tool, icon: Icon, label }: { tool: typeof activeTool; icon: any; label: string }) => (
    <button
      onClick={() => {
        setActiveTool(tool);
        if (tool !== 'wall') cancelDrawing();
      }}
      className={`flex flex-col items-center gap-1 p-3 rounded-xl transition-all ${
        activeTool === tool 
          ? 'bg-[#4a90d9] text-white shadow-lg' 
          : 'bg-white text-gray-600 hover:bg-gray-100 shadow'
      }`}
    >
      <Icon size={24} />
      <span className="text-xs font-medium">{label}</span>
    </button>
  );

  return (
    <div ref={containerRef} className="w-full h-full relative bg-[#f5f5f5] overflow-hidden">
      {/* Canvas */}
      <canvas
        ref={canvasRef}
        className={`absolute inset-0 ${isPanning ? 'cursor-grabbing' : activeTool === 'wall' ? 'cursor-crosshair' : 'cursor-default'}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        onWheel={handleWheel}
        style={{ touchAction: 'none' }}
      />
      
      {/* Toolbar Superior */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-2 p-2 bg-white/90 backdrop-blur-lg rounded-2xl shadow-lg border border-gray-200">
        <ToolButton tool="select" icon={MousePointer2} label="Selecionar" />
        <ToolButton tool="wall" icon={Square} label="Parede" />
        <ToolButton tool="room" icon={Grid3X3} label="Cômodo" />
        <ToolButton tool="door" icon={DoorOpen} label="Porta" />
        <ToolButton tool="window" icon={SquareIcon} label="Janela" />
        <ToolButton tool="furniture" icon={Armchair} label="Móvel" />
      </div>
      
      {/* Toolbar Direita - Controles */}
      <div className="absolute top-4 right-4 flex flex-col gap-2">
        <div className="p-2 bg-white/90 backdrop-blur-lg rounded-xl shadow-lg border border-gray-200 flex flex-col gap-1">
          <button
            onClick={() => setScale(prev => Math.min(200, prev * 1.2))}
            className="w-10 h-10 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-600"
            title="Zoom In"
          >
            <ZoomIn size={20} />
          </button>
          <div className="text-center text-xs text-gray-500 py-1">
            {scale.toFixed(0)}%
          </div>
          <button
            onClick={() => setScale(prev => Math.max(5, prev * 0.8))}
            className="w-10 h-10 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-600"
            title="Zoom Out"
          >
            <ZoomOut size={20} />
          </button>
          <div className="w-full h-px bg-gray-200 my-1" />
          <button
            onClick={() => { setScale(25); setOffset({ x: 0, y: 0 }); }}
            className="w-10 h-10 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-600"
            title="Reset View"
          >
            <RotateCcw size={18} />
          </button>
        </div>
        
        <div className="p-2 bg-white/90 backdrop-blur-lg rounded-xl shadow-lg border border-gray-200 flex flex-col gap-1">
          <button
            onClick={() => setSnapEnabled(!snapEnabled)}
            className={`w-10 h-10 flex items-center justify-center rounded-lg transition-colors ${
              snapEnabled ? 'bg-[#4a90d9]/10 text-[#4a90d9]' : 'hover:bg-gray-100 text-gray-600'
            }`}
            title="Snap"
          >
            <Grid3X3 size={18} />
          </button>
          <button
            onClick={() => setShowMeasurements(!showMeasurements)}
            className={`w-10 h-10 flex items-center justify-center rounded-lg transition-colors ${
              showMeasurements ? 'bg-[#4a90d9]/10 text-[#4a90d9]' : 'hover:bg-gray-100 text-gray-600'
            }`}
            title="Medidas"
          >
            <Move size={18} />
          </button>
        </div>
      </div>
      
      {/* Info Inferior */}
      <div className="absolute bottom-4 left-4 flex gap-2">
        <div className="px-4 py-2 bg-white/90 backdrop-blur-lg rounded-xl shadow-lg border border-gray-200">
          <div className="text-xs text-gray-500">
            Pos: {mousePos.x.toFixed(0)}, {mousePos.y.toFixed(0)}
          </div>
          {snapResult && snapResult.type !== 'none' && (
            <div className="text-xs text-[#4a90d9] font-medium">
              Snap: {snapResult.type}
            </div>
          )}
        </div>
        
        {drawingState.isDrawing && (
          <div className="px-4 py-2 bg-[#4a90d9] text-white rounded-xl shadow-lg flex items-center gap-2">
            <span className="text-sm font-medium">Desenhando...</span>
            <button
              onClick={cancelDrawing}
              className="p-1 hover:bg-white/20 rounded"
            >
              <X size={16} />
            </button>
            <button
              onClick={() => drawingState.currentWall && continueDrawing(drawingState.currentWall.end)}
              className="p-1 hover:bg-white/20 rounded"
            >
              <Check size={16} />
            </button>
          </div>
        )}
      </div>
      
      {/* Escala */}
      <div className="absolute bottom-4 right-4 px-3 py-2 bg-white/90 backdrop-blur-lg rounded-xl shadow-lg border border-gray-200">
        <div className="flex items-center gap-2 text-xs text-gray-600">
          <div className="w-8 h-0.5 bg-gray-400" />
          <span>1m</span>
        </div>
      </div>
      
      {/* Instruções */}
      {activeTool === 'wall' && !drawingState.isDrawing && (
        <div className="absolute top-20 left-1/2 -translate-x-1/2 px-4 py-2 bg-gray-800/80 text-white text-sm rounded-lg">
          Clique para começar a desenhar uma parede
        </div>
      )}
    </div>
  );
};

export default Canvas2D;
