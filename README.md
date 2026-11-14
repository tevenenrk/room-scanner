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
2. **Spust**: skan zostaje zapisany i od razu przechodzisz do **pomiarów w tej samej sesji AR**:
   widzisz prawdziwy pokój z nałożoną siatką i rysujesz pomiary spustem. Ponieważ to ta sama
   sesja, skan i pomiary są dokładnie na swoim miejscu. **B / Y** zapisuje skan i wychodzi.
3. **Odtwórz w VR**: stoisz w wirtualnej kopii pokoju, w tym samym miejscu i skali.
4. **W pokoju (AR)**: skan i pomiary na obrazie z kamer, w prawdziwym pokoju.
   Gogle odnajdują ten sam model pokoju (Space Setup) i dopasowują do niego skan.
5. **Eksport**:
   - `GLB`: model 3D pokoju (Blender, Podgląd 3D w Windows, przeglądarki),
   - `PLY pokoju`: chmura punktów z widocznych warstw (CloudCompare, MeshLab),
   - `PLY pomiarów`: pomiary z wartościami wszystkich pól jako osobne „scalar fields”
     (CloudCompare),
   - `JSON`: pełna kopia (pokój + pomiary) do ponownego wczytania.

### Wyrównanie skanu w kolejnych sesjach

Quest przy każdym wejściu do VR/AR ustawia początek układu współrzędnych tam, gdzie akurat
stoisz, więc bez wyrównania pokój i pomiary pojawiałyby się przesunięte. Aplikacja wyrównuje
skan automatycznie (w VR i w AR):

1. **wg siatki pokoju**: gogle podają położenie tego samego modelu pokoju (Space Setup), co przy skanowaniu,
2. **wg granicy (Guardian)**: zapasowo, jeśli strona nie dostanie siatki pokoju,
3. **ręcznie**: menu → „Dopasuj ręcznie”, potem grip i przesuwasz/obracasz pokój, aż pasuje do
   rzeczywistości (najwygodniej w AR). „Auto wyrównanie” wraca do automatu.

Stan wyrównania widać na tabliczce nad lewym pilotem. Ostrzeżenie „Skan nie wyrównany” oznacza,
że trzeba dopasować ręcznie. Skany zrobione przed tą zmianą nie mają zapisanej granicy, więc
działa dla nich tylko wyrównanie wg siatki albo ręczne.

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

Do tego krycie (przezroczystość) pól i pokoju oraz skala kolorów z wartościami min/max.

**Zakres widocznych wartości**: cały pasek skali to wartości od najmniejszego do największego
pomiaru. Suwakami „od” / „do” (na komputerze) albo przeciągając uchwyty na pasku w menu gogli
zawężasz widoczny zakres. Wartości spoza niego znikają, a cała tęcza zostaje rozciągnięta na to,
co zostało, więc im węższy zakres, tym dokładniej widać różnice. Opcja **„Wytnij ten zakres”**
działa odwrotnie: ukrywa wybrany fragment, a reszta zostaje w pełnej skali.

### Paletka pomiarowa

Zamiast jednej kulki na końcu pilota może być **paletka z wieloma kulkami** (każda kulka to
osobny czujnik i osobny punkt pomiaru). W menu gogli:

- **Kulek na paletce** ◀ ▶: każda nowa kulka dokłada się w układzie heksagonalnym
  (1 → 7 to pełny pierwszy pierścień, 19 → drugi, 37 → trzeci, do 91), więc paletka rośnie,
- **Wielkość kulki pomiaru**: rozmiar kulek, a odstęp między nimi rośnie razem z nimi.

Paletka leży płasko wzdłuż pilota (jak rakietka) i obraca się razem z nadgarstkiem. Jedno
przeciągnięcie spustem zapisuje pomiar z każdej kulki, więc szybko pokrywasz duży obszar.
Udawane Arduino wysyła wtedy osobną wartość dla każdej kulki (z lekkim rozrzutem jak w prawdziwych czujnikach).

### Przekroje

- **Utnij dach** na dowolnej wysokości (widok z góry: przycisk „Z góry” na komputerze,
  „Makieta z góry” w goglach),
- **Przekrój pionowy** wzdłuż osi X lub Z, z wyborem, która strona zostaje,
- **Mapa pola** na płaszczyźnie: poziomo / pionowo X / pionowo Z przez cały pokój albo
  **„w ręce”**: płaszczyzna trzymana lewym pilotem (rozpięta wzdłuż pilota i w bok, obrót
  nadgarstka zmienia jej nachylenie). Mapa przelicza się na bieżąco, gdy nią poruszasz.
  **Lewy spust** stawia ją w miejscu, a kolejny lewy spust znowu ją podnosi. Postawiona
  płaszczyzna jest też widoczna na komputerze jako „ręczna (z gogli)”. Rozmiar ustawisz w menu.

Przekroje tną zarówno pokój, jak i pola.

### Makieta z góry

Pokój w miniaturze przed tobą, jak model na stole. Chwytasz go **gripem**:

- jedna ręka: przesuwanie i obracanie razem z dłonią,
- dwie ręce: dodatkowo skalowanie (rozsuwanie/zsuwanie dłoni) i obrót wokół pionu,
- prawa gałka w bok: obracanie makiety wokół jej środka.

### Sterowanie w goglach

| Przycisk | Działanie |
|---|---|
| **Y** (lewy) | menu: celujesz pilotem (żółty kursor i podświetlenie pokazują, w co celujesz), spust = klik, przytrzymanie = przeciąganie suwaka |
| **X** (lewy) | następne pole |
| **A** (prawy) | następny widok pola |
| **B** (prawy) | tryb pomiaru wł./wył. |
| **spust** (w trybie pomiaru) | rysowanie pomiarów kulką w powietrzu |
| prawa gałka góra/dół | z Arduino (gałka): wartość bieżącego pola; inaczej (w trybie pomiaru) wielkość kulki |
| grip + prawa gałka góra/dół | wielkość kulki (przy Arduino) |
| lewa gałka | chodzenie (VR) |
| prawa gałka w bok | obrót o 30° (VR); w makiecie obrót makiety |
| grip (w makiecie) | chwycenie makiety, dwoma rękami także skala |
| lewy spust (mapa „w ręce”) | postaw / podnieś płaszczyznę mapy |
| wciśnięcie lewej gałki | powrót na start (VR) |

Nad lewym pilotem jest tabliczka ze skalą kolorów i wartością pola w miejscu kulki:
wartość z czujnika w trybie pomiaru, a poza nim wartość z zebranych pomiarów („sonda”).
W menu są też: krycie, zakres widocznych wartości (od / do / wytnij), przekroje, mapa pola, makieta z góry (pokój w miniaturze
na wysokości stołu), zapis i czyszczenie pomiarów. Pomiary zapisują się też automatycznie
po wyjściu z gogli.

### Arduino: tryb symulacji (gałka)

W panelu **Czujnik** (na komputerze) albo w menu gogli wybierz źródło **Arduino (symulacja, gałka)**.
Program dostaje wtedy dane tak, jakby Arduino było już podłączone: udawane urządzenie
wysyła ok. 20 pakietów na sekundę (linie JSON, opis niżej), a program je parsuje i używa
ostatniego odczytu. Wartości ustawiasz sam:

- w goglach **prawa gałka góra/dół** zmienia wartość bieżącego pola (przełączanego **X**),
  a z wciśniętym **grip** zmienia wielkość kulki,
- w menu: „wartość z Arduino” ◀ ▶ (skok o 5 % zakresu),
- na komputerze: suwaki dla każdego pola.

Pole magnetyczne jest wektorem: kierunek to kierunek, w który wskazuje pilot (jak trzyosiowy
czujnik przymocowany do pilota), a długość ustawiasz gałką. Tabliczka nad lewym pilotem pokazuje
bieżącą wartość z Arduino, a panel na komputerze pokazuje surowe pakiety i liczbę pakietów na sekundę.
Jeśli przez ponad sekundę nie przyjdzie żaden pakiet, pomiary się nie zapisują („brak danych”).

### Protokół danych z Arduino

Jedna linia tekstu (zakończona `\n`) = jeden pakiet JSON:

```
{"fields":[{"id":"wifi","name":"Sygnał WiFi","unit":"dBm","components":1}, ...]}   <- opcjonalnie, na start
{"t":12345,"wifi":-52.3,"mag":[12.1,-40.3,-18.0],"temp":21.4}                     <- pomiar
{"t":12345,"wifi":-52.3,...,"s":[{"wifi":-51.8,"temp":21.4},{"wifi":-53.0},...]}   <- paletka
```

`s` (opcjonalne) to odczyty z wielu czujników paletki, w kolejności kulek: środek, potem
kolejne pierścienie heksagonu. Brakujące pola biorą wartość z części głównej pakietu.

`t` to `millis()` z Arduino, wektor zapisuje się jako `[x, y, z]`. Parser to `parseSensorLine`
w `src/sensors.js`, a `StreamSensor` przyjmuje linie (`ingest(line)`) i trzyma ostatni odczyt.
Prawdziwe połączenie (np. ESP32 przez Bluetooth LE albo WebSocket po WiFi) ma tylko podawać
odebrane linie do `ingest()`, a reszta programu zostaje bez zmian. Pozycję pomiaru daje pilot,
do którego przymocowany jest czujnik.

## Zdjęcia na skanie (tekstura)

W goglach (najlepiej w AR, np. zaraz po skanowaniu) w menu:

- **Zdjęcia auto**: zdjęcie robi się samo, gdy przejdziesz ok. 35 cm albo obrócisz głowę o ok. 25°
  (do 150 zdjęć). Chodź i rozglądaj się powoli po całym pokoju,
- **Zrób zdjęcie**: pojedyncze zdjęcie.

Po wyjściu z gogli zdjęcia są automatycznie **nakładane na siatkę pokoju**, a tryb pokoju zmienia
się na **Zdjęcia**:

1. siatka jest dzielona na małe trójkąty (ok. 5 cm),
2. dla każdego zdjęcia liczona jest mapa głębi, więc miejsca zasłonięte (np. podłoga za
   stołem) nie dostają złego koloru,
3. każdy punkt bierze kolor ze zdjęć, które widziały go najbardziej na wprost i z bliska (mieszanie 3 najlepszych).

Miejsca, których nie widziało żadne zdjęcie, zostają szare. Na komputerze w sekcji **Pokój** są
przyciski „Nałóż zdjęcia” (ponownie) i „Usuń zdjęcia”. Gdy przeglądarka daje tylko zwykły obraz
z kamery (getUserMedia), kąt widzenia kamery jest przybliżony; jeśli kolory „rozjeżdżają się” z
geometrią, popraw suwak **Kąt widzenia kamery**, a zdjęcia nałożą się ponownie.

## Ograniczenia (ważne)

- **Zdjęcia zależą od przeglądarki.** Czy strona dostanie obraz z kamer gogli (WebXR
  camera-access albo getUserMedia), zależy od wersji Quest Browser; jeśli nie, aplikacja
  pokaże komunikat „Brak dostępu do kamery”, a model zostaje kolorowany umownie.
- **Szczegółowość zależy od Space Setup.** Quest 3S nie ma czujnika głębi, który ma Quest 3,
  więc siatka jest bardziej zgrubna: ściany, meble i większe przedmioty będą, drobiazgi raczej nie.
- Eksport GLB zawiera pokój (z kolorami ze zdjęć, jeśli są nałożone). Pomiary są w eksporcie JSON i „PLY pomiarów”.
- Pomiary są na razie symulowane (patrz wyżej), prawdziwego połączenia z Arduino jeszcze nie ma.
- Skany są zapisane w przeglądarce na tym urządzeniu. Wyczyszczenie danych przeglądarki je
  usunie, więc ważne skany eksportuj do GLB/JSON.

Jeśli zależy Ci na **fotorealistycznej** kopii pokoju, Meta ma do tego własną aplikację
**Hyperscape Capture** (Quest 3 / 3S; sprawdź, czy jest dostępna w Twoim regionie). Hyperscape
liczy model (Gaussian splatting) na serwerach Meta przez wiele godzin, więc w przeglądarce
na goglach nie da się tego odtworzyć. Tutaj zdjęcia są nakładane na siatkę Space Setup.

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
src/sensors.js            źródła danych: symulacja pól, udawane Arduino, protokół JSON
src/photo-capture.js      zdjęcia z kamer gogli (WebXR camera-access / getUserMedia)
src/photo-texture.js      nakładanie zdjęć na siatkę (mapy głębi, wybór najlepszych zdjęć)
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
