import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestCategory } from '../public/shared/categorize.js';

const CATEGORIES = [
  { id: 'eldhusid', name: 'Í eldhúsið' },
  { id: 'heimilid', name: 'Fyrir heimilið' },
  { id: 'hjonarumid', name: 'Hjónarúmið' },
  { id: 'bordstofan', name: 'Borðstofan' },
  { id: 'bakstur', name: 'Bakstur' },
  { id: 'utivist', name: 'Útivist' },
  { id: 'annad', name: 'Annað' },
];
const cat = (name) => suggestCategory(name, CATEGORIES);

test('baking things go to Bakstur', () => {
  for (const name of ['Mæliskeiðar 4 stk', 'Skálasett úr stáli', 'KitchenAid Artisan hrærivél', 'Kökuform 24 cm',
    'Kökukefli úr beyki', 'Muffinsform 12 stk', 'Eldhúsvog', 'Þeytari', 'Sleikja'])
    assert.equal(cat(name), 'bakstur', name);
});

test('the other categories', () => {
  assert.equal(cat('Le Creuset Steypujárnspottur 24 CM'), 'eldhusid');
  assert.equal(cat('Global Nakiri hnífur 18cm'), 'eldhusid');
  assert.equal(cat('Vínglös 4 stk'), 'bordstofan');
  assert.equal(cat('Hnífapör fyrir 6'), 'bordstofan'); // not "hnífur"
  assert.equal(cat('Salatskál úr olíuviði'), 'bordstofan'); // not "skál" → Bakstur
  assert.equal(cat('Kökudiskur á fæti'), 'bakstur'); // not "diskur" → Borðstofan
  assert.equal(cat('Sængurföt 140x200'), 'hjonarumid');
  assert.equal(cat('Ilmkerti með furuilm'), 'heimilid');
  assert.equal(cat('Útivistarstóll'), 'utivist'); // a custom category by its own name
});

test('compound words: the main word is at the end (kokkahnífur, eggjapískur)', () => {
  assert.equal(cat('KOKKAHNÍFUR 27CM - G-17'), 'eldhusid');
  assert.equal(cat('SKÆRI 21CM - GKS-210'), 'eldhusid');
  assert.equal(cat('Töng - GS-28'), 'eldhusid');
  assert.equal(cat('PROFI PLUS - PÍSKUR 30CM'), 'bakstur');
  assert.equal(cat('Ibili Bollamál stál 4stk'), 'bakstur');
  assert.equal(cat('Funktion Mælikanna glær 300ml'), 'bakstur'); // not "kanna" → Borðstofan
  assert.equal(cat('APS Mæliskeiðasett stál 4stk á hring'), 'bakstur');
  assert.equal(cat('Kitchenaid Sleikja svört'), 'bakstur');
  assert.equal(cat('Blómapottur úr leir'), 'heimilid'); // not "pottur" → Í eldhúsið
  assert.equal(cat('Hnífapör fyrir 6'), 'bordstofan');
});

test('no guess when nothing matches, and "Annað" is never suggested', () => {
  assert.equal(cat('Gjafabréf í leikhús'), '');
  assert.equal(cat(''), '');
  assert.equal(suggestCategory('Mæliskeiðar', [{ id: 'annad', name: 'Annað' }]), '');
});
