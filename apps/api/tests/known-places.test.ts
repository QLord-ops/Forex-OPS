import { describe, expect, it, vi } from 'vitest';
import { resolveAddressWithFallback } from '../src/services/address-resolution.js';
import type { AddressRuleRecord } from '../src/services/address-rules.js';
import { findKnownPlace, fitsPostcodeRegion, KnownPlaces, resolveWithoutGeocoder, streetKey, type KnownPlace } from '../src/services/known-places.js';
import type { RoutingProvider } from '../src/services/routing.js';

const place = (name: string, street: string | null, postalCode: string | null, city: string | null, latitude = 52.1, longitude = 10.3): KnownPlace =>
  ({ name, street, postalCode, city, latitude, longitude, provider: 'webfleet-address' });
const vw = place('Volkswagen AG Werk Salzgitter', 'Industriestraße Nord 1', '38239', 'Salzgitter', 52.19, 10.4);
const man = place('MAN Truck & Bus SE', 'Heinrich-Büssing-Str. 1', '38239', 'Salzgitter', 52.16, 10.41);
const lager = place('Schnellecke Logistics', 'Rudolf-Diesel-Straße 2a', '14974', 'Ludwigsfelde', 52.3, 13.25);
// The book knows where a postcode region lies: other doors of 38…, 14… and 28… vouch for a stored point there.
const witnesses = [
  place('Salzgitter Flachstahl', 'Eisenhüttenstraße 99', '38239', 'Salzgitter', 52.15, 10.42), place('Bosch', 'John-F.-Kennedy-Straße 43', '38228', 'Salzgitter', 52.14, 10.33),
  place('Mercedes-Benz Werk', 'Zum Industriepark 10', '14974', 'Ludwigsfelde', 52.31, 13.27), place('Rhenus', 'Brandenburger Allee 2', '14974', 'Ludwigsfelde', 52.29, 13.24), place('DHL', 'Märkische Allee 1', '14979', 'Großbeeren', 52.35, 13.3),
  place('BLG', 'Senator-Blase-Straße 1', '28197', 'Bremen', 53.08, 8.72), place('Mercedes-Benz Werk Bremen', 'Im Holter Feld 1', '28309', 'Bremen', 53.05, 8.9), place('Kühne', 'Hans-Böckler-Straße 2', '28217', 'Bremen', 53.09, 8.77)
];
const book = [vw, man, lager, ...witnesses];

describe('a door of the address book', () => {
  it('is the same however the street is written', () => {
    expect(streetKey('Rudolf-Diesel-Straße 2a')).toBe(streetKey('Rudolf Diesel Str. 2 A'));
    expect(streetKey('Industriestrasse Nord 1')).toBe(streetKey('Industriestr. Nord 1'));
    expect(streetKey('Salzgitter')).toBe('');
    expect(streetKey('14974 Ludwigsfelde')).toBe('');
  });

  it('is found by street, house number and postcode, and by nothing less', () => {
    expect(findKnownPlace({ address: 'Rudolf Diesel Str. 2A, 14974 Ludwigsfelde', city: 'Ludwigsfelde', company: 'Lager' }, book)).toBe(lager);
    expect(findKnownPlace({ address: 'Industriestr. Nord 1, D 38239 Salzgitter', company: 'VW' }, book)).toBe(vw);
    // Another house number, another postcode or no postcode: the geocoder decides.
    expect(findKnownPlace({ address: 'Rudolf-Diesel-Straße 4, 14974 Ludwigsfelde' }, book)).toBeNull();
    expect(findKnownPlace({ address: 'Rudolf-Diesel-Straße 2a, 21129 Hamburg' }, book)).toBeNull();
    expect(findKnownPlace({ address: 'Rudolf-Diesel-Straße 2a' }, book)).toBeNull();
    expect(findKnownPlace({ address: '' }, book)).toBeNull();
  });

  it('is found by company and town for a stop without a street only when the book has one such company there', () => {
    expect(findKnownPlace({ address: 'Salzgitter', city: 'Salzgitter', company: 'Volkswagen AG Werk Salzgitter' }, book)).toBe(vw);
    expect(findKnownPlace({ address: 'Salzgitter', city: 'Salzgitter', company: 'VW' }, book)).toBeNull();
    expect(findKnownPlace({ address: 'Salzgitter', city: 'Wolfsburg', company: 'Volkswagen AG Werk Salzgitter' }, book)).toBeNull();
    const second = place('Volkswagen AG Werk Salzgitter', 'Tor 3', '38239', 'Salzgitter');
    expect(findKnownPlace({ address: 'Salzgitter', city: 'Salzgitter', company: 'Volkswagen AG Werk Salzgitter' }, [...book, second])).toBeNull();
  });

  it('tells two towns of one name apart by the postcode printed in the city field (Petershagen)', () => {
    const westfalen = place('Muster Logistik', 'Industriestraße 12', '32469', 'Petershagen', 52.38, 8.97);
    const brandenburg = place('Muster Logistik', 'Industriestraße 12', '15370', 'Petershagen', 52.53, 13.79);
    const both = [brandenburg, westfalen];
    expect(findKnownPlace({ address: 'Industriestraße 12', city: '32469 Petershagen', company: 'Muster Logistik' }, both)).toBe(westfalen);
    expect(findKnownPlace({ address: 'Petershagen', city: 'D-32469 Petershagen', company: 'Muster Logistik' }, both)).toBe(westfalen);
    expect(findKnownPlace({ address: 'Petershagen', city: 'Petershagen', company: 'Muster Logistik' }, both)).toBeNull();
  });

  it('does not use a learned rule of a namesake town with another postcode without measuring it', () => {
    const rule = { kind: 'SITE', pattern: 'muster logistik petershagen', company: 'Muster Logistik', street: 'Industriestraße 12', postalCode: '15370', city: 'Petershagen',
      latitude: 52.53, longitude: 13.79, builtIn: false } as unknown as AddressRuleRecord;
    expect(resolveWithoutGeocoder({ address: 'Petershagen', city: '32469 Petershagen', company: 'Muster Logistik' }, [rule], [])).toBeNull();
    // Its own postcode is taken once the book knows that region; without such doors the full lookup measures the point.
    expect(resolveWithoutGeocoder({ address: 'Petershagen', city: '15370 Petershagen', company: 'Muster Logistik' }, [rule], [])).toBeNull();
    const east = [place('A', 'Am Markt 1', '15344', 'Strausberg', 52.58, 13.88), place('B', 'Hauptstraße 2', '15366', 'Neuenhagen', 52.53, 13.69), place('C', 'Bahnhofstraße 3', '15562', 'Rüdersdorf', 52.47, 13.78)];
    expect(resolveWithoutGeocoder({ address: 'Petershagen', city: '15370 Petershagen', company: 'Muster Logistik' }, [rule], east)).toMatchObject({ latitude: 52.53 });
  });

  it('the printed postcode decides, not the label of a stored place: «15370 Petershagen» saved at Minden is dropped (owner, 20.11)', async () => {
    const east = [place('A', 'Am Markt 1', '15344', 'Strausberg', 52.58, 13.88), place('B', 'Hauptstraße 2', '15366', 'Neuenhagen', 52.53, 13.69), place('C', 'Bahnhofstraße 3', '15562', 'Rüdersdorf', 52.47, 13.78)];
    const minden = { latitude: 52.38, longitude: 8.97 };
    expect(fitsPostcodeRegion(minden, '15370', east)).toBe(false);
    expect(fitsPostcodeRegion({ latitude: 52.52, longitude: 13.77 }, '15370', east)).toBe(true);
    expect(fitsPostcodeRegion(minden, '15370', east.slice(0, 2))).toBeNull();
    // A rule learned while the stop stood in the namesake town carries the right label and the wrong point.
    const rule = { kind: 'SITE', pattern: 'hl corporation berlin 15370 petershagen', company: 'HL Corporation Berlin', street: null, postalCode: '15370', city: 'Petershagen',
      ...minden, builtIn: false } as unknown as AddressRuleRecord;
    const stop = { address: '15370 Petershagen', city: '15370 Petershagen', company: 'HL Corporation Berlin' };
    expect(resolveWithoutGeocoder(stop, [rule], east)).toBeNull();
    // The same door of the address book with the wrong point.
    const door = { ...place('HL Corporation Berlin', 'Lessingstraße 5', '15370', 'Petershagen'), ...minden, provider: 'ops-address' };
    expect(resolveWithoutGeocoder({ address: 'Lessingstraße 5, 15370 Petershagen', city: 'Petershagen', company: 'HL Corporation Berlin' }, [], [...east, door])).toBeNull();

    // The full lookup measures both against the postcode's own area and takes the geocoder's answer at Berlin.
    const area = { label: '15370 Petershagen/Eggersdorf', city: 'Petershagen/Eggersdorf', postalCode: '15370', latitude: 52.52, longitude: 13.76, provider: 'nominatim' };
    const routing = { geocodePostcode: vi.fn(async () => area), geocode: vi.fn(async () => area) } as unknown as RoutingProvider;
    const byRule = await resolveAddressWithFallback(routing, stop, undefined, [rule], []);
    expect(byRule).toMatchObject({ latitude: 52.52, longitude: 13.76 });
    expect(byRule.attempts.join(' ')).toContain('отброшено');
    const street = { ...area, label: 'Lessingstraße 5, 15370 Petershagen', street: 'Lessingstraße', houseNumber: '5', latitude: 52.521, longitude: 13.78 };
    const routed = { geocodePostcode: vi.fn(async () => area), geocode: vi.fn(async () => street) } as unknown as RoutingProvider;
    const byDoor = await resolveAddressWithFallback(routed, { address: 'Lessingstraße 5, 15370 Petershagen', city: 'Petershagen', company: 'HL Corporation Berlin' }, undefined, [], [door]);
    expect(byDoor).toMatchObject({ latitude: 52.521, longitude: 13.78 });
    expect(byDoor.attempts.join(' ')).toContain('адресная книга «HL Corporation Berlin» отброшена');
  });
});

describe('coordinates without the geocoder', () => {
  const rule = (extra: Partial<AddressRuleRecord>): AddressRuleRecord => ({ id: 'r1', kind: 'SITE', pattern: 'seifert bremen', company: 'Seifert Logistics', street: 'Ludwig-Erhard-Str. 5', postalCode: '28197', city: 'Bremen',
    latitude: 53.07, longitude: 8.74, requiresTermin: false, builtIn: false, ...extra } as AddressRuleRecord);

  it('gives a preview stop the place of the book or of a learned rule of the same town', () => {
    const fromBook = resolveWithoutGeocoder({ address: 'Industriestraße Nord 1, 38239 Salzgitter', city: 'Salzgitter', company: 'VW' }, [], book);
    expect(fromBook).toMatchObject({ latitude: 52.19, longitude: 10.4, precision: 'EXACT', provider: 'webfleet-address', sourceAddress: 'Industriestraße Nord 1, 38239 Salzgitter',
      resolvedAddress: 'Volkswagen AG Werk Salzgitter, Industriestraße Nord 1, 38239 Salzgitter' });

    const fromRule = resolveWithoutGeocoder({ address: 'Ludwig-Erhard-Str. 5, 28197 Bremen', city: 'Bremen', company: 'Seifert' }, [rule({})], book);
    expect(fromRule).toMatchObject({ latitude: 53.07, provider: 'address-rule', precision: 'EXACT' });
    // A rule that names another town is not trusted without the distance check of the full lookup.
    expect(resolveWithoutGeocoder({ address: 'Hafenstr. 1, 20457 Hamburg', city: 'Hamburg', company: 'Seifert' }, [rule({ pattern: 'seifert' })], book)).toBeNull();
    expect(resolveWithoutGeocoder({ address: 'Unbekannte Str. 9, 01234 Dresden', city: 'Dresden', company: 'Neu' }, [], book)).toBeNull();
    expect(resolveWithoutGeocoder({ address: null }, [], book)).toBeNull();
  });

  it('answers the address lookup from the book before any geocoder call', async () => {
    const geocode = vi.fn(async () => { throw new Error('the geocoder must not be asked'); });
    const routing = { geocode } as unknown as RoutingProvider;
    const result = await resolveAddressWithFallback(routing, { address: 'Rudolf-Diesel-Str. 2a, 14974 Ludwigsfelde', city: 'Ludwigsfelde', company: 'Lager' }, undefined, [], book);
    expect(result).toMatchObject({ latitude: 52.3, longitude: 13.25, precision: 'EXACT', provider: 'webfleet-address', attempts: ['адресная книга: Schnellecke Logistics'] });
    expect(geocode).not.toHaveBeenCalled();
  });

  it('keeps the book in memory for a minute', async () => {
    const findMany = vi.fn(async () => [{ source: 'WEBFLEET', name: 'VW', street: 'A 1', postalCode: '38239', city: 'Salzgitter', latitude: 1, longitude: 2 }]);
    const places = new KnownPlaces({ knownAddress: { findMany } } as never);
    expect(await places.all(1000)).toEqual([{ name: 'VW', street: 'A 1', postalCode: '38239', city: 'Salzgitter', latitude: 1, longitude: 2, provider: 'webfleet-address' }]);
    await places.all(30_000);
    expect(findMany).toHaveBeenCalledTimes(1);
    await places.all(62_000);
    expect(findMany).toHaveBeenCalledTimes(2);
  });
});
