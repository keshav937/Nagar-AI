import { useState, useCallback } from 'react';
import type { GeoLocationState } from '../types.ts';
import { apiFetch } from '../api/client.ts';

export function useGeolocation() {
  const [geo, setGeo] = useState<GeoLocationState>({
    status: 'idle',
    lat: null,
    lng: null,
    accuracyM: null,
    address: '',
    ward: '',
    timestamp: null,
    errorMessage: null,
  });

  const resolveAddress = useCallback(async (lat: number, lng: number) => {
    try {
      const res = await apiFetch<{ address: string; ward: string }>(`/api/geo/reverse?lat=${lat}&lng=${lng}`);
      return res;
    } catch {
      return { address: `${lat.toFixed(5)}, ${lng.toFixed(5)}`, ward: 'Urban Zone' };
    }
  }, []);

  const requestLocation = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGeo((prev) => ({
        ...prev,
        status: 'unavailable',
        errorMessage: 'Browser geolocation is not supported on this device. Please select a location on the map.',
      }));
      return null;
    }

    setGeo((prev) => ({ ...prev, status: 'requesting', errorMessage: null }));

    return new Promise<GeoLocationState | null>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          const { latitude, longitude, accuracy } = pos.coords;
          const resolved = await resolveAddress(latitude, longitude);
          const next: GeoLocationState = {
            status: 'acquired',
            lat: latitude,
            lng: longitude,
            accuracyM: Math.round(accuracy),
            address: resolved.address,
            ward: resolved.ward,
            timestamp: new Date(pos.timestamp).toISOString(),
            errorMessage: null,
          };
          setGeo(next);
          resolve(next);
        },
        (err) => {
          const status =
            err.code === err.PERMISSION_DENIED
              ? 'denied'
              : err.code === err.TIMEOUT
                ? 'timeout'
                : 'unavailable';
          const msg =
            status === 'denied'
              ? 'Location permission was denied. You can search an address or click the map to place a pin manually.'
              : status === 'timeout'
                ? 'GPS signal timed out. Try refreshing outdoors or place your pin manually on the map.'
                : 'Unable to detect GPS coordinates right now. Use manual search or map pin fallback.';
          setGeo((prev) => ({
            ...prev,
            status,
            errorMessage: msg,
          }));
          resolve(null);
        },
        {
          enableHighAccuracy: true,
          timeout: 10_000,
          maximumAge: 30_000,
        }
      );
    });
  }, [resolveAddress]);

  const setManualLocation = useCallback(
    async (lat: number, lng: number, customAddress?: string) => {
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return;
      }
      const resolved = customAddress
        ? { address: customAddress, ward: 'Manual Pin' }
        : await resolveAddress(lat, lng);
      setGeo({
        status: 'manual',
        lat,
        lng,
        accuracyM: null,
        address: resolved.address,
        ward: resolved.ward,
        timestamp: new Date().toISOString(),
        errorMessage: null,
      });
    },
    [resolveAddress]
  );

  return {
    geo,
    requestLocation,
    setManualLocation,
  };
}
