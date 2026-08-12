/** Simple architectural materials for the live 3D MVP (not photoreal). */

export const ARCH_MATERIALS = {
  wall: {
    color: '#D9D2C5',
    roughness: 0.88,
    metalness: 0,
  },
  roof: {
    color: '#4A5560',
    roughness: 0.55,
    metalness: 0.2,
  },
  slab: {
    color: '#A8A29A',
    roughness: 0.92,
    metalness: 0,
  },
  windowGlass: {
    color: '#1a2a32',
    roughness: 0.12,
    metalness: 0.35,
    transparent: true,
    opacity: 0.55,
  },
  door: {
    color: '#5c4033',
    roughness: 0.72,
    metalness: 0.05,
  },
  garageDoor: {
    color: '#6b7280',
    roughness: 0.65,
    metalness: 0.15,
  },
  trim: {
    color: '#F5F0E6',
    roughness: 0.7,
    metalness: 0,
  },
} as const;
