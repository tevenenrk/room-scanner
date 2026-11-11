# Skaner pokoju (Meta Quest 3 / 3S)

Aplikacja WebXR: skanujesz pomieszczenie goglami, zapisujesz je, a potem odtwarzasz
w VR jako model 3D (bryła, siatka albo chmura punktów) i możesz po nim chodzić.
Działa w **przeglądarce Meta Quest**, więc nic nie trzeba instalować, nie trzeba
trybu dewelopera ani Unity.

## Jak to działa

Quest 3 / 3S przy **Space Setup** (Konfiguracja przestrzeni) sam buduje model pokoju:
trójkątną siatkę wszystkich powierzchni, ściany, podłogę, sufit, drzwi, okna i bryły
mebli. Przeglądarka Quest udostępnia go stronom przez WebXR (`mesh-detection`,
`plane-detection`) po zgodzie użytkownika. Aplikacja:

1. **Skanuj pokój**: otwiera tryb AR (obraz z kamer) i na żywo nakłada zebraną siatkę
   na rzeczywistość. Jeśli pokój nie był jeszcze skanowany, spust (albo szczypnięcie)
   uruchamia systemowe skanowanie. Wtedy rozglądasz się powoli po pomieszczeniu.
2. Spust: **zapisz i wyjdź**. Skan trafia do pamięci przeglądarki (IndexedDB) na goglach.
3. **Odtwórz w VR**: stoisz w wirtualnej kopii pokoju, w tym samym miejscu i skali.
   - lewa gałka: chodzenie, prawa gałka: obrót o 30°
   - **A / X**: bryła → siatka → chmura punktów
   - **B / Y**: warstwy (siatka pokoju / meble / płaszczyzny)
   - wciśnięcie gałki: powrót na start
4. **Nałóż na pokój (AR)**: wyświetla zapisany skan na obrazie z kamer, więc widać,
   co się zmieniło od skanowania.
5. **Eksport**:
   - `GLB`: model 3D (Blender, Podgląd 3D w Windows, przeglądarki),
   - `PLY`: chmura punktów z widocznych warstw (CloudCompare, MeshLab),
   - `JSON`: pełna kopia do ponownego wczytania (np. na innym urządzeniu).

Na komputerze/telefonie strona działa jako przeglądarka 3D: można otworzyć wyeksportowany
skan, obejrzeć go myszką i wyeksportować do innych formatów. Jest też **przykładowy pokój**
do wypróbowania bez gogli.

## Ograniczenia (ważne)

- **Brak kolorów/tekstur ze zdjęć.** WebXR nie daje stronom obrazu z kamer gogli, więc
  model jest kolorowany umownie: wysokością i typem obiektu (ściana, stół, kanapa...).
- **Szczegółowość zależy od Space Setup.** Quest 3S nie ma czujnika głębi, który ma Quest 3,
  więc siatka jest bardziej zgrubna: ściany, meble i większe przedmioty będą, drobiazgi raczej nie.
- Skany są zapisane w przeglądarce na tym urządzeniu. Wyczyszczenie danych przeglądarki je
  usunie, więc ważne skany eksportuj do GLB/JSON.

Jeśli zależy Ci na **fotorealistycznej** kopii pokoju, Meta ma do tego własną aplikację
**Hyperscape Capture** (Quest 3 / 3S; sprawdź, czy jest dostępna w Twoim regionie).
Kolorową wersję tej aplikacji też da się zrobić, ale jako natywną aplikację w Unity z
Passthrough Camera API i Depth API. To już większy projekt.

## Uruchomienie na goglach

WebXR wymaga **HTTPS**. Najprościej przez GitHub Pages:

1. W repozytorium na GitHubie: **Settings → Pages → Build and deployment → Source:
   Deploy from a branch**, wybierz gałąź z tym kodem i folder `/ (root)`.
2. Po minucie strona będzie pod adresem `https://<użytkownik>.github.io/room-scanner/`.
3. Otwórz ten adres w przeglądarce na Queście (dodaj do zakładek).
4. Przy pierwszym skanowaniu zezwól na dostęp do **danych przestrzennych / otoczenia**.

Lokalnie (programowanie): `python3 -m http.server 8000` i na goglach podłączonych kablem
`adb reverse tcp:8000 tcp:8000`, potem w przeglądarce Quest `http://localhost:8000`
(`localhost` jest traktowany jako bezpieczny kontekst).

## Struktura

```
index.html, style.css     interfejs (po polsku)
src/main.js               logika ekranów i przycisków
src/ar-scanner.js         sesja AR: zbieranie mesh-detection / plane-detection
src/viewer.js             podgląd 3D + odtwarzanie w VR/AR, lokomocja
src/scan-model.js         format skanu, kolory, chmura punktów, pokój demo
src/file-formats.js       eksport/import GLB, PLY, JSON
src/storage.js            zapis skanów w IndexedDB
src/xr-panel.js           panel z tekstem w goglach
vendor/three/             three.js r170 (MIT), dołączony, żeby działało bez CDN
```

Bez kroku budowania: czysty JavaScript (moduły ES) + three.js.

Współrzędne skanu to przestrzeń `local-floor` (metry, Y w górę, podłoga na y = 0).
Dzięki temu odtworzony pokój pojawia się wokół Ciebie z podłogą na właściwej wysokości.
