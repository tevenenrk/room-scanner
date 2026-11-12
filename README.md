# Skaner pokoju (Meta Quest 3 / 3S)

Aplikacja WebXR: skanujesz pomieszczenie goglami, zapisujesz je, a potem odtwarzasz
w VR jako model 3D (bryła, siatka albo chmura punktów) i możesz po nim chodzić.
W pokoju możesz też „malować” pomiary pól (WiFi, pole magnetyczne, temperatura...)
kulką na pilocie i oglądać je jako kropki, kostki, strzałki albo mapy w przekrojach.
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
4. **W pokoju (AR)**: skan i pomiary na obrazie z kamer, w prawdziwym pokoju.
   Gogle odnajdują ten sam model pokoju (Space Setup) i dopasowują do niego skan.
5. **Eksport**:
   - `GLB`: model 3D pokoju (Blender, Podgląd 3D w Windows, przeglądarki),
   - `PLY pokoju`: chmura punktów z widocznych warstw (CloudCompare, MeshLab),
   - `PLY pomiarów`: pomiary z wartościami wszystkich pól jako osobne „scalar fields”
     (CloudCompare),
   - `JSON`: pełna kopia (pokój + pomiary) do ponownego wczytania.

## Pomiary pól

Każdy pomiar to punkt w przestrzeni, wielkość kulki pomiarowej (jak duży obszar był
mierzony) i wartości wszystkich pól naraz. Na razie wartości pochodzą z **symulowanego
czujnika** (`SimulatedSensor` w `src/fields.js`), który udaje:

- **sygnał WiFi** [dBm]: router w rogu pokoju, tłumienie z odległością, interferencje,
- **pole magnetyczne** [µT, wektor]: pole Ziemi, głośnik na stole (dipol), kabel z prądem przy ścianie,
- **temperaturę** [°C]: kaloryfer pod oknem, chłód od drzwi, cieplej pod sufitem.

**Przykładowy pokój** ma już ok. 3000 takich pomiarów. Do dowolnego skanu można je dodać
przyciskiem „+ Symulowane pomiary”.

### Widoki pól

- **Kropki**: każdy pomiar jako kolorowa kropka,
- **Kulki pomiaru**: kulka o rozmiarze faktycznie mierzonego obszaru,
- **Kostki 3D**: pomiary uśrednione w sześcianach (rozmiar regulowany),
- **Strzałki**: dla pól wektorowych kierunek pola, dla skalarnych kierunek, w którym wartość rośnie
  (np. gdzie WiFi jest silniejsze),
- **Mapa pola na płaszczyźnie**: kolorowa mapa w przekroju poziomym albo pionowym.

Do tego krycie (przezroczystość) pól i pokoju, **próg** (ukrywa niższe wartości, zostają
„gorące” miejsca) i skala kolorów z wartościami min/max.

### Przekroje

- **Utnij dach** na dowolnej wysokości (widok z góry: przycisk „Z góry” na komputerze,
  „Makieta z góry” w goglach),
- **Przekrój pionowy** wzdłuż osi X lub Z, z wyborem, która strona zostaje,
- **Mapa pola** na niezależnej płaszczyźnie (poziomo / pionowo X / pionowo Z).

Przekroje tną zarówno pokój, jak i pola.

### Sterowanie w goglach

| Przycisk | Działanie |
|---|---|
| **Y** (lewy) | menu: celujesz prawym pilotem, spust = klik |
| **X** (lewy) | następne pole |
| **A** (prawy) | następny widok pola |
| **B** (prawy) | tryb pomiaru wł./wył. |
| **spust** (w trybie pomiaru) | rysowanie pomiarów kulką w powietrzu |
| prawa gałka góra/dół (w trybie pomiaru) | wielkość kulki |
| lewa gałka | chodzenie (VR) |
| prawa gałka w bok | obrót o 30° (VR) |
| wciśnięcie lewej gałki | powrót na start (VR) |

Nad lewym pilotem jest tabliczka ze skalą kolorów i wartością pola w miejscu kulki:
wartość z czujnika w trybie pomiaru, a poza nim wartość z zebranych pomiarów („sonda”).
W menu są też: krycie, próg, przekroje, mapa pola, makieta z góry (pokój w miniaturze
na wysokości stołu), zapis i czyszczenie pomiarów. Pomiary zapisują się też automatycznie
po wyjściu z gogli.

### Podłączenie prawdziwych czujników (Arduino), plan

Czujnik musi mieć ten sam interfejs co `SimulatedSensor`:

```js
{
  fields: [{ id: 'wifi', name: 'Sygnał WiFi', unit: 'dBm', components: 1 }, ...],
  read(position) { return { wifi: -52, mag: [12.1, -40.3, -18.0], ... }; }
}
```

W praktyce: Arduino (np. ESP32 z magnetometrem, czujnikiem temperatury i własnym
odczytem RSSI WiFi) przypięte do pilota wysyła odczyty kilkadziesiąt razy na sekundę,
np. przez Bluetooth LE albo WebSocket po WiFi. Klasa czujnika trzyma ostatni odczyt, a
`read()` go zwraca. Pozycję w pokoju daje pilot, więc wystarczy znać przesunięcie
czujnika względem pilota.

Na komputerze/telefonie strona działa jako przeglądarka 3D: można otworzyć wyeksportowany
skan, obejrzeć go myszką i wyeksportować do innych formatów. Jest też **przykładowy pokój**
do wypróbowania bez gogli.

## Ograniczenia (ważne)

- **Brak kolorów/tekstur ze zdjęć.** WebXR nie daje stronom obrazu z kamer gogli, więc
  model jest kolorowany umownie: wysokością i typem obiektu (ściana, stół, kanapa...).
- **Szczegółowość zależy od Space Setup.** Quest 3S nie ma czujnika głębi, który ma Quest 3,
  więc siatka jest bardziej zgrubna: ściany, meble i większe przedmioty będą, drobiazgi raczej nie.
- Eksport GLB zawiera tylko pokój. Pomiary są w eksporcie JSON i „PLY pomiarów”.
- Pomiary są na razie symulowane (patrz wyżej).
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
src/viewer.js             podgląd 3D + gogle (VR/AR): przekroje, menu, pomiary, lokomocja
src/fields.js             pomiary, symulowany czujnik, skala kolorów, woksele, interpolacja
src/field-view.js         wizualizacja pól: kropki, kulki, kostki, strzałki, mapa
src/xr-menu.js            menu w goglach (promień + spust) i tabliczka z legendą
src/scan-model.js         format skanu, kolory, chmura punktów, pokój demo
src/file-formats.js       eksport/import GLB, PLY, JSON
src/storage.js            zapis skanów w IndexedDB
src/xr-panel.js           panel z tekstem w goglach
vendor/three/             three.js r170 (MIT), dołączony, żeby działało bez CDN
```

Bez kroku budowania: czysty JavaScript (moduły ES) + three.js.

Współrzędne skanu to przestrzeń `local-floor` (metry, Y w górę, podłoga na y = 0).
Dzięki temu odtworzony pokój pojawia się wokół Ciebie z podłogą na właściwej wysokości.
