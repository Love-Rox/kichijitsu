import { ExtensionStorage } from "@bacons/apple-targets";
import * as Location from "expo-location";
import { getMeta, setMeta } from "./localDb";

/**
 * ウィジェットの天気(Apple WeatherKit)を出す場所。この端末だけの設定。
 * 設定した場所は、アプリの DB(画面の表示用)と、App Group の UserDefaults("weatherPlace"、ウィジェットが読む)
 * の両方に JSON で書く。現在地は「使うボタンを押した、その一回」の座標を保存するだけで、バックグラウンドでは追わない。
 */
export interface WeatherPlace {
  name: string;
  latitude: number;
  longitude: number;
}

const APP_GROUP = "group.cc.love-rox.kichijitsu";
const KEY = "weatherPlace";
const storage = new ExtensionStorage(APP_GROUP);

export async function getWeatherPlace(): Promise<WeatherPlace | null> {
  const raw = await getMeta(KEY);
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as WeatherPlace;
    return Number.isFinite(p.latitude) && Number.isFinite(p.longitude) ? p : null;
  } catch {
    return null;
  }
}

/** 場所を保存してウィジェットへ渡す。null で解除(ウィジェットの天気は「場所を設定してください」になる)。 */
export async function saveWeatherPlace(place: WeatherPlace | null): Promise<void> {
  const json = place ? JSON.stringify(place) : "";
  await setMeta(KEY, json);
  storage.set(KEY, json);
  ExtensionStorage.reloadWidget();
}

function nameOf(a: Location.LocationGeocodedAddress | undefined, fallback: string): string {
  if (!a) return fallback;
  const parts = [a.region, a.city ?? a.subregion, a.district].filter((s): s is string => !!s);
  // 重複(東京都 / 東京都 など)は省く
  const uniq = parts.filter((s, i) => parts.indexOf(s) === i);
  return uniq.length > 0 ? uniq.join(" ") : (a.name ?? fallback);
}

/** 地名・住所から、候補の場所を最大 5 件探す(iOS のジオコーダー。通信が要る)。 */
export async function searchPlaces(query: string): Promise<WeatherPlace[]> {
  const q = query.trim();
  if (!q) return [];
  const found = await Location.geocodeAsync(q);
  const top = found.slice(0, 5);
  return Promise.all(
    top.map(async (f) => {
      const [addr] = await Location.reverseGeocodeAsync({ latitude: f.latitude, longitude: f.longitude }).catch(() => []);
      return { name: nameOf(addr, q), latitude: f.latitude, longitude: f.longitude };
    }),
  );
}

/** 今いる場所の座標を一回だけ取る。許可が無ければ null(許可を求めて、断られたとき)。 */
export async function currentPlace(): Promise<WeatherPlace | null> {
  const perm = await Location.requestForegroundPermissionsAsync();
  if (!perm.granted) return null;
  const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
  const { latitude, longitude } = pos.coords;
  const [addr] = await Location.reverseGeocodeAsync({ latitude, longitude }).catch(() => []);
  return { name: nameOf(addr, "現在地"), latitude, longitude };
}
