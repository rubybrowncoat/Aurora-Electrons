"""Audit Aurora maps and build a separate Aurora Electrons map demonstration DB.

The layout comes from arrange_combined_map.py, which needs NumPy to place systems without saved coordinates.
Source databases are always opened read-only.
The output is for map visualization, not an Aurora gameplay save.
"""

import argparse
import collections
import hashlib
import json
import math
import random
from pathlib import Path
import sqlite3


def connect(path):
    db = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA query_only=ON')
    return db


def rows(db, table, game):
    return [dict(row) for row in db.execute(f'SELECT * FROM "{table}" WHERE GameID=?', (game,))]


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def components(systems, jumps):
    neighbors = {s['SystemID']: set() for s in systems}
    by_id = {j['WarpPointID']: j for j in jumps}
    for jump in jumps:
        peer = by_id.get(jump['WPLink'])
        if peer and jump['SystemID'] in neighbors and peer['SystemID'] in neighbors:
            neighbors[jump['SystemID']].add(peer['SystemID'])
            neighbors[peer['SystemID']].add(jump['SystemID'])
    result = []
    remaining = set(neighbors)
    while remaining:
        pending = [min(remaining)]
        group = set()
        while pending:
            node = pending.pop()
            if node in group:
                continue
            group.add(node)
            pending.extend(neighbors[node] - group)
        remaining -= group
        result.append(sorted(group))
    return sorted(result, key=lambda group: (-len(group), group[0]))


def audit_game(db, game, filename):
    gid = game['GameID']
    systems = rows(db, 'FCT_System', gid)
    jumps = rows(db, 'FCT_JumpPoint', gid)
    by_id = {j['WarpPointID']: j for j in jumps}
    system_ids = {s['SystemID'] for s in systems}
    paired = [j for j in jumps if j['WPLink'] in by_id]
    invalid = [j['WarpPointID'] for j in jumps if j['SystemID'] not in system_ids or (j['WPLink'] and j['WPLink'] not in by_id) or (j['WPLink'] in by_id and by_id[j['WPLink']]['WPLink'] != j['WarpPointID'])]
    physical = sorted(systems, key=lambda s: s['SystemID'])
    # Fingerprints are diagnostic only, never map identity or universe lineage.
    system_hash = digest(physical)
    jump_hash = digest(sorted(jumps, key=lambda j: j['WarpPointID']))
    graph = [[s['SystemID'], s['SystemNumber']] for s in physical]
    edges = sorted([j['WarpPointID'], j['SystemID'], j['WPLink'], j['Distance'], j['Bearing'], j['Xcor'], j['Ycor']] for j in jumps)
    map_hash = digest([graph, edges])
    names = [dict(r) for r in db.execute('SELECT RaceID,RaceName,NPR FROM FCT_Race WHERE GameID=?', (gid,))]
    return dict(file=filename, game_id=gid, game_name=game['GameName'], systems=len(systems), stars=len(rows(db, 'FCT_Star', gid)), bodies=db.execute('SELECT COUNT(*) FROM FCT_SystemBody WHERE GameID=?', (gid,)).fetchone()[0], jump_points=len(jumps), connections=len(paired)//2, unlinked=sum(not j['WPLink'] for j in jumps), components=[len(group) for group in components(systems, jumps)], invalid_jump_ids=invalid, system_hash=system_hash, jump_hash=jump_hash, map_hash=map_hash, races=names)


def audit(base, folder, destination):
    destination.mkdir(parents=True, exist_ok=True)
    files = [base] + sorted(folder.glob('*.db'))
    records = []
    for path in files:
        with connect(path) as db:
            games = [dict(row) for row in db.execute('SELECT * FROM FCT_Game ORDER BY GameID')]
            for game in games:
                record = audit_game(db, game, str(path.resolve()))
                records.append(record)
                print(f'{path.name} | {record["game_name"]} ({record["game_id"]}) | {record["systems"]} systems, {record["connections"]} links, {len(record["components"])} components', flush=True)
    groups = collections.defaultdict(list)
    for record in records:
        groups[(record['game_id'], record['game_name'])].append(record)
    selected = []
    duplicates = []
    for group in groups.values():
        # Prefer the base on equal counts, then a stable filename ordering.
        winner = min(group, key=lambda r: (-r['systems'], r['file'] != str(base.resolve()), r['file']))
        selected.append(winner)
        if len(group) > 1:
            duplicates.append(dict(game_id=winner['game_id'], game_name=winner['game_name'], selected=winner, skipped=[r for r in group if r is not winner]))
    result = dict(base=str(base.resolve()), source_folder=str(folder.resolve()), games=records, selected_maps=selected, duplicate_maps=duplicates, duplicate_rule='Exact GameID + GameName; greatest system count; ties prefer base then filename')
    (destination / 'map-audit.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    lines = ['# Aurora database map comparison', '',
             'Duplicate maps have the same GameID and GameName. Keep the copy with the most systems. Equal counts prefer the base database, then filename order. Shared IDs alone do not indicate duplicates or related universes. Fingerprints are diagnostic only.', '',
             '| Database | Game | Systems | Stars | Bodies | Paired connections | Unlinked jump points | Components |',
             '|---|---|---:|---:|---:|---:|---:|---:|']
    for r in records:
        lines.append(f'| {Path(r["file"]).name} | {r["game_name"]} ({r["game_id"]}) | {r["systems"]} | {r["stars"]} | {r["bodies"]} | {r["connections"]} | {r["unlinked"]} | {len(r["components"])} |')
    lines += ['', '## Duplicate selections', '',
              '| Game | Selected database | Systems | Skipped copies (systems) |', '|---|---|---:|---|']
    for group in duplicates:
        winner = group['selected']
        skipped = '; '.join(f'{Path(r["file"]).name} ({r["systems"]})' for r in group['skipped'])
        lines.append(f'| {winner["game_name"]} ({winner["game_id"]}) | {Path(winner["file"]).name} | {winner["systems"]} | {skipped} |')
    (destination / 'map-comparison.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    return result


def build(audit_result, destination, game_id, race_id, seed=None):
    if seed is None:
        seed = random.SystemRandom().randrange(2**32)
    rng = random.Random(seed)
    output = destination / 'AuroraDB_combined_maps.db'
    if output.exists():
        raise FileExistsError(f'Refusing to overwrite {output}')
    sources = {r['file'] for r in audit_result['games']}
    source_stats = {p: (Path(p).stat().st_size, Path(p).stat().st_mtime_ns) for p in sources}
    base = connect(audit_result['base'])
    target = next(r for r in audit_result['games'] if r['file'] == audit_result['base'] and r['game_id'] == game_id)
    if target not in audit_result['selected_maps']:
        raise ValueError('The base target is not the largest duplicate; choose a base containing the selected copy')
    selected_race = base.execute('SELECT RaceTitle FROM FCT_Race WHERE GameID=? AND RaceID=?', (game_id, race_id)).fetchone()
    if not selected_race:
        raise ValueError('Target race does not belong to target game')
    if any(r['invalid_jump_ids'] for r in audit_result['games']):
        raise ValueError('Source maps contain invalid jump links')
    db = sqlite3.connect(output.resolve().as_uri(), uri=True)
    db.row_factory = sqlite3.Row
    base.backup(db)
    db.execute('PRAGMA journal_mode=DELETE')
    db.execute('BEGIN')
    schemas = {}
    counters = {}
    manifest = dict(base=audit_result['base'], output=str(output.resolve()), game_id=game_id, race_id=race_id, purpose='Aurora Electrons map visualization only; not a gameplay save', imports=[], skipped_duplicates=audit_result['duplicate_maps'], bridges=[], schema_omissions={}, duplicate_rule=audit_result['duplicate_rule'], random_seed=seed, connection_policy='2 or 3 leaf-to-leaf links per map; original secondary components retained')

    def columns(table):
        if table not in schemas:
            schemas[table] = [r['name'] for r in db.execute(f'PRAGMA table_info("{table}")')]
        return schemas[table]

    def allocate(table, key, originals):
        counter = (table, key)
        if counter not in counters:
            counters[counter] = db.execute(f'SELECT COALESCE(MAX("{key}"),0) FROM "{table}"').fetchone()[0]
        result = {}
        for original in originals:
            counters[counter] += 1
            result[original] = counters[counter]
        return result

    def insert(table, records):
        grouped = collections.defaultdict(list)
        for record in records:
            keys = tuple(k for k in columns(table) if k in record)
            grouped[keys].append(tuple(record[k] for k in keys))
        for keys, values in grouped.items():
            fields = ','.join('"' + k + '"' for k in keys)
            parameters = ','.join('?' for _ in keys)
            db.executemany(f'INSERT INTO "{table}" ({fields}) VALUES ({parameters})', values)

    def know_map(source, gid, system_map, jump_map, label='', position=None):
        races = [r['RaceID'] for r in source.execute('SELECT RaceID FROM FCT_Race WHERE GameID=? ORDER BY NPR,RaceID', (gid,))]
        priority = {race: i for i, race in enumerate(races)}
        names = {}
        surveys = rows(source, 'FCT_RaceSysSurvey', gid)
        for survey in sorted(surveys, key=lambda r: priority.get(r['RaceID'], len(priority))):
            names.setdefault(survey['SystemID'], survey)
        src_systems = {r['SystemID']: r for r in rows(source, 'FCT_System', gid)}
        for index, (old, new) in enumerate(system_map.items()):
            previous = db.execute('SELECT 1 FROM FCT_RaceSysSurvey WHERE RaceID=? AND SystemID=?', (race_id, new)).fetchone()
            if previous:
                continue
            name = names.get(old, {}).get('Name')
            if not name or name in ('Not Yet Named', 'Unknown'):
                name = f'System {src_systems[old]["SystemNumber"]} / {old}'
            record = dict(GameID=game_id, RaceID=race_id, SystemID=new, Name=label + name, DiscoveredTime=0, SurveyDone=1)
            if position:
                width, x, y = position
                record.update(Xcor=x + (index % width)*160, Ycor=y + (index//width)*130)
            elif old in names:
                record.update(Xcor=names[old]['Xcor'], Ycor=names[old]['Ycor'])
            insert('FCT_RaceSysSurvey', [record])
        actual_jumps = {j['WarpPointID']: j for j in rows(source, 'FCT_JumpPoint', gid)}
        for old, new in jump_map.items():
            existing = db.execute('SELECT 1 FROM FCT_RaceJumpPointSurvey WHERE RaceID=? AND WarpPointID=?', (race_id, new)).fetchone()
            explored = int(bool(actual_jumps[old]['WPLink']))
            if existing:
                db.execute('UPDATE FCT_RaceJumpPointSurvey SET Charted=1,Explored=?,Hide=0 WHERE RaceID=? AND WarpPointID=?', (explored, race_id, new))
            else:
                insert('FCT_RaceJumpPointSurvey', [dict(GameID=game_id, RaceID=race_id, WarpPointID=new, Charted=1, Explored=explored, Hide=0)])

    base_systems = rows(base, 'FCT_System', game_id)
    base_jumps = rows(base, 'FCT_JumpPoint', game_id)
    know_map(base, game_id, {s['SystemID']: s['SystemID'] for s in base_systems}, {j['WarpPointID']: j['WarpPointID'] for j in base_jumps})
    regions = [(dict(file=audit_result['base'], game_id=game_id, game_name=target['game_name']), group) for group in components(base_systems, base_jumps)]
    imported_number = 0
    tables = ['FCT_System', 'FCT_Star', 'FCT_SystemBody', 'FCT_JumpPoint', 'FCT_SurveyLocation', 'FCT_LagrangePoint', 'FCT_AtmosphericGas', 'FCT_MineralDeposit', 'FCT_RuinRace', 'FCT_AncientConstruct', 'FCT_AetherRift']
    primary_keys = dict(FCT_System='SystemID', FCT_Star='StarID', FCT_SystemBody='SystemBodyID', FCT_JumpPoint='WarpPointID', FCT_SurveyLocation='SurveyLocationID', FCT_LagrangePoint='LagrangePointID', FCT_RuinRace='RuinRaceID', FCT_AncientConstruct='AncientConstructID')
    for record in audit_result['selected_maps']:
        if record == target:
            continue
        imported_number += 1
        with connect(record['file']) as source:
            available = {r[0] for r in source.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            data = {t: rows(source, t, record['game_id']) for t in tables if t in available}
            maps = {key: allocate(table, key, [r[key] for r in data.get(table, [])]) for table, key in primary_keys.items()}
            catalogue = {}
            for system in data['FCT_System']:
                number = system['SystemNumber']
                if number < 0 or number in catalogue:
                    continue
                row = source.execute('SELECT * FROM DIM_KnownSystems WHERE KnownSystemID=?', (number,)).fetchone()
                if row:
                    new_id = allocate('DIM_KnownSystems', 'KnownSystemID', [number])[number]
                    copy = dict(row)
                    copy.update(KnownSystemID=new_id, GameID=game_id)
                    insert('DIM_KnownSystems', [copy])
                    catalogue[number] = new_id
            for table, entries in data.items():
                omissions = sorted(set(entries[0]) - set(columns(table))) if entries else []
                if omissions:
                    manifest['schema_omissions'][Path(record['file']).name + ':' + table] = omissions
                for entry in entries:
                    entry['GameID'] = game_id
                    for key, mapping in maps.items():
                        if key in entry and entry[key] in mapping:
                            entry[key] = mapping[entry[key]]
                    if table == 'FCT_System':
                        entry['SystemNumber'] = catalogue.get(entry['SystemNumber'], entry['SystemNumber'])
                    elif table == 'FCT_SystemBody':
                        parent_map = maps['StarID'] if entry['ParentBodyType'] == 0 else maps['SystemBodyID']
                        entry['ParentBodyID'] = parent_map.get(entry['ParentBodyID'], entry['ParentBodyID'])
                        entry['FixedBodyParentID'] = maps['SystemBodyID'].get(entry.get('FixedBodyParentID'), 0)
                    elif table == 'FCT_JumpPoint':
                        entry['WPLink'] = maps['WarpPointID'].get(entry['WPLink'], 0)
                        entry['JumpGateRaceID'] = 0
                    elif table == 'FCT_LagrangePoint':
                        entry['PlanetID'] = maps['SystemBodyID'].get(entry['PlanetID'], 0)
                insert(table, entries)
            label = f'[{imported_number:02d} {record["game_name"]}] '
            grid_width = max(2, math.ceil(math.sqrt(record['systems'])))
            x = 10000 + ((imported_number-1) % 5)*8000
            y = 10000 + ((imported_number-1) // 5)*8000
            know_map(source, record['game_id'], maps['SystemID'], maps['WarpPointID'], label, (grid_width, x, y))
            # Preserve source geology/gravitational survey counts using the first human race's knowledge; immediate map visibility is independent.
            primary_race = source.execute('SELECT RaceID FROM FCT_Race WHERE GameID=? ORDER BY NPR,RaceID LIMIT 1', (record['game_id'],)).fetchone()
            if primary_race:
                for table in ['FCT_SystemBodySurveys', 'FCT_RaceSurveyLocation', 'FCT_SystemBodyName']:
                    entries = [dict(r) for r in source.execute(f'SELECT * FROM "{table}" WHERE GameID=? AND RaceID=?', (record['game_id'], primary_race[0]))]
                    # Rows for bodies or systems no longer in the donor map (destroyed bodies) are dropped rather than pointed at ID 0.
                    entries = [entry for entry in entries if all(entry[key] in maps[key] for key in ('SystemID', 'SystemBodyID') if key in entry)]
                    for entry in entries:
                        entry.update(GameID=game_id, RaceID=race_id)
                        for key in ('SystemID', 'SystemBodyID'):
                            if key in entry:
                                entry[key] = maps[key][entry[key]]
                    insert(table, entries)
            # Re-read original graph because insertion remapped data in place.
            groups = components(rows(source, 'FCT_System', record['game_id']), rows(source, 'FCT_JumpPoint', record['game_id']))
            regions.extend((dict(file=record['file'], game_id=record['game_id'], game_name=record['game_name']), [maps['SystemID'][sid] for sid in group]) for group in groups)
            manifest['imports'].append(dict(file=record['file'], game_id=record['game_id'], game_name=record['game_name'], label=label, systems=record['systems'], connections=record['connections'], components=len(groups), id_maps=maps))
        print(f'Imported {label}: {record["systems"]} systems', flush=True)

    def identity(region):
        return (region[0]['file'], region[0]['game_id'])

    by_map = collections.defaultdict(list)
    region_by_system = {}
    for region in regions:
        by_map[identity(region)].extend(region[1])
        region_by_system.update((sid, region) for sid in region[1])
    if len(by_map) < 2:
        raise ValueError('At least two nonempty maps are needed for inter-map links')
    existing_pairs = set()

    def add_bridge(left, right, kind):
        previous, current = region_by_system[left], region_by_system[right]
        assert identity(previous) != identity(current)
        pair = tuple(sorted((left, right)))
        assert pair not in existing_pairs
        existing_pairs.add(pair)
        ids = allocate('FCT_JumpPoint', 'WarpPointID', [0, 1])
        for side, system, peer in [(0, left, ids[1]), (1, right, ids[0])]:
            # 10 AU from the star: Xcor/Ycor in km as the app's route calculations read them, and Distance in AU as the game stores it.
            distance = 1496000000.0
            bearing = rng.randrange(360)
            radians = math.radians(bearing)
            insert('FCT_JumpPoint', [dict(WarpPointID=ids[side], GameID=game_id, SystemID=system, WPLink=peer, Distance=distance / 149600000.0, Bearing=bearing, Xcor=distance*math.sin(radians), Ycor=-distance*math.cos(radians), JumpGateStrength=0, JumpGateRaceID=0)])
            insert('FCT_RaceJumpPointSurvey', [dict(GameID=game_id, RaceID=race_id, WarpPointID=ids[side], Charted=1, Explored=1, Hide=0)])
        manifest['bridges'].append(dict(from_system=left, to_system=right, from_region=previous[0], to_region=current[0], jump_ids=list(ids.values()), kind=kind))

    from arrange_combined_map import bounds, leaf_pairs, pack_maps, source_layout, write_reports
    original_degrees = collections.Counter(j['SystemID'] for j in rows(db, 'FCT_JumpPoint', game_id) if j['WPLink'])
    before_positions = {r['SystemID']: (r['Xcor'], r['Ycor']) for r in rows(db, 'FCT_RaceSysSurvey', game_id) if r['RaceID'] == race_id}
    leaf_maps = []
    source_records = [dict(file=audit_result['base'], game_id=game_id, game_name=target['game_name'])]+manifest['imports']
    for index, ((map_id, systems), record) in enumerate(zip(by_map.items(), source_records)):
        assert map_id == (record['file'], record['game_id'])
        main_region = max((r for r in regions if identity(r) == map_id), key=lambda r: len(r[1]))
        leaves = [sid for sid in main_region[1] if original_degrees[sid] <= 1]
        if not leaves:
            raise ValueError(f'No leaf systems in {map_id}')
        with connect(record['file']) as source:
            source_systems = rows(source, 'FCT_System', record['game_id'])
            source_jumps = rows(source, 'FCT_JumpPoint', record['game_id'])
            mapping = {s['SystemID']: s['SystemID'] for s in source_systems} if index == 0 else record['id_maps']['SystemID']
            by_jump = {j['WarpPointID']: j for j in source_jumps}
            edges = sorted({tuple(sorted((j['SystemID'], by_jump[j['WPLink']]['SystemID']))) for j in source_jumps if j['WPLink'] in by_jump})
            local, fixed, reference = source_layout(source, record['game_id'], race_id if index == 0 else None, set(mapping), edges, seed+index)
        leaf_maps.append(dict(systems=systems, leaves=leaves, positions={mapping[sid]: point for sid, point in local.items()}, preserved={mapping[sid]: point for sid, point in fixed.items()}, reference_race=dict(race_id=reference[0], name=reference[1], npr=reference[2])))
    offsets = pack_maps(leaf_maps)
    positions = {sid: (x+offsets[i][0], y+offsets[i][1]) for i, item in enumerate(leaf_maps) for sid, (x, y) in item['positions'].items()}
    db.executemany('UPDATE FCT_RaceSysSurvey SET Xcor=?,Ycor=? WHERE GameID=? AND RaceID=? AND SystemID=?', [(x, y, game_id, race_id, sid) for sid, (x, y) in positions.items()])
    manifest['layout'] = dict(policy='Source coordinates preserved by translation only; unknown positions use anchored spring placement; map bounds separated by 140 units', seed=seed, before_bounds=bounds(before_positions), after_bounds=bounds(positions), maps=[])
    for index, (record, item) in enumerate(zip(source_records, leaf_maps)):
        offset = offsets[index]
        assert all(positions[sid] == (point[0]+offset[0],point[1]+offset[1]) for sid, point in item['preserved'].items())
        manifest['layout']['maps'].append(dict(file=record['file'],game_id=record['game_id'],game_name=record['game_name'], reference_race=item['reference_race'],translation=offset,source_positions_preserved=len(item['preserved']), generated_positions=len(item['systems'])-len(item['preserved']),source_positions=item['preserved']))
    for left, right, kind in leaf_pairs(leaf_maps, positions):
        add_bridge(left, right, kind)
        manifest['bridges'][-1]['source_leaf_degrees'] = [original_degrees[left], original_degrees[right]]
    db.commit()
    (destination / 'merge-manifest.pending.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    # Exact source data is protected by read-only handles. Check external saves did not change while this run was constructing the snapshot.
    if any((Path(p).stat().st_size, Path(p).stat().st_mtime_ns) != state for p, state in source_stats.items()):
        raise RuntimeError('A source database changed during assembly')
    integrity = db.execute('PRAGMA integrity_check').fetchone()[0]
    result = audit_game(db, dict(GameID=game_id, GameName=target['game_name']), str(output.resolve()))
    assert integrity == 'ok', integrity
    assert not result['invalid_jump_ids'], result['invalid_jump_ids']
    assert len(result['components']) == len(regions)-len(by_map)+1, result['components']
    assert result['systems'] == target['systems'] + sum(r['systems'] for r in manifest['imports'])
    assert result['connections'] == target['connections'] + sum(r['connections'] for r in manifest['imports']) + len(manifest['bridges'])
    added_degrees = collections.Counter(identity(region_by_system[sid]) for b in manifest['bridges'] for sid in (b['from_system'], b['to_system']))
    assert all(2 <= added_degrees[map_id] <= 3 for map_id in by_map)
    for record in manifest['layout']['maps']:
        record['connections'] = added_degrees[(record['file'],record['game_id'])]
    visible = db.execute('SELECT COUNT(*) FROM FCT_RaceSysSurvey WHERE GameID=? AND RaceID=?', (game_id, race_id)).fetchone()[0]
    assert visible == result['systems'], (visible, result['systems'])
    assert db.execute('SELECT COUNT(*) FROM FCT_RaceJumpPointSurvey WHERE GameID=? AND RaceID=? AND Charted=1', (game_id, race_id)).fetchone()[0] == result['jump_points']
    # Every original base table row must be preserved byte-for-byte at SQL level, except the selected race's jump visibility flags, intentionally revealed, and its system positions: the layout gives places to the systems the save left at the (0,0) placeholder or without coordinates, so only those two columns may differ, and only for such systems.
    db.execute('ATTACH DATABASE ? AS original', (Path(audit_result['base']).resolve().as_uri() + '?mode=ro',))
    for row in db.execute("SELECT name FROM original.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall():
        table = row[0]
        where = ' WHERE NOT (GameID=? AND RaceID=?)' if table in ('FCT_RaceJumpPointSurvey', 'FCT_RaceSysSurvey') else ''
        params = (game_id, race_id) if where else ()
        missing = db.execute(f'SELECT COUNT(*) FROM (SELECT * FROM original."{table}"{where} EXCEPT SELECT * FROM main."{table}")', params).fetchone()[0]
        assert missing == 0, (table, missing)
    scope = ' FROM {}."FCT_RaceSysSurvey" WHERE GameID=? AND RaceID=?'
    others = ','.join(f'"{r[1]}"' for r in db.execute('PRAGMA original.table_info("FCT_RaceSysSurvey")') if r[1] not in ('Xcor', 'Ycor'))
    missing = db.execute(f'SELECT COUNT(*) FROM (SELECT {others}{scope.format("original")} EXCEPT SELECT {others}{scope.format("main")})', (game_id, race_id) * 2).fetchone()[0]
    assert missing == 0, ('FCT_RaceSysSurvey', 'columns other than Xcor and Ycor', missing)
    recorded = ' AND Xcor BETWEEN -1e308 AND 1e308 AND Ycor BETWEEN -1e308 AND 1e308 AND NOT (Xcor=0 AND Ycor=0)'
    moved = db.execute(f'SELECT COUNT(*) FROM (SELECT SystemID,Xcor,Ycor{scope.format("original")}{recorded} EXCEPT SELECT SystemID,Xcor,Ycor{scope.format("main")})', (game_id, race_id) * 2).fetchone()[0]
    assert moved == 0, ('FCT_RaceSysSurvey', 'recorded positions', moved)
    manifest['validation'] = dict(sqlite_integrity=integrity, target=result, visible_systems=visible, base_rows_preserved=True, source_files_unchanged=True)
    (destination / 'merge-manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    (destination / 'merge-manifest.pending.json').unlink()
    summary = ['# Combined Aurora Electrons map', '',
               f'Open `{output.name}` in Aurora Electrons; select **{target["game_name"]}**, race **{selected_race[0]}**.',
               '', 'This is a separate map visualization database, not an Aurora gameplay save.', '',
               f'- {result["systems"]:,} visible systems; {result["connections"]:,} paired jump connections.',
               f'- {len(manifest["imports"])} donor maps plus the original target map.',
               f'- {len(manifest["bridges"])} new reciprocal bridges; each map receives two or three leaf-to-leaf connections.',
               '- All original systems, jump connections, empires and colonies are preserved.',
               '- Imported stars, bodies, survey locations, atmospheres, minerals and natural landmarks are included.',
               '- Donor populations, fleets and races are not imported; imported regions have origin prefixes.',
               '- Duplicates match GameID and GameName; the copy with most systems is selected. Shared IDs alone imply no relationship.',
               '- Every new link crosses maps and uses source leaves (degree one), or isolated systems (degree zero).',
               '- The largest original region of each map joins the common network; original secondary regions retain their disconnected topology.',
               '- Existing target systems and jumps are revealed; geology survey records retain their source knowledge.',
               '- Donor map coordinates use separate grids. Use the map Arrange controls to refine the layout.',
               '- The JSON manifest records ID translations, source provenance, duplicates and every bridge.',
               '- Verification: SQLite integrity, reciprocal links, full connectivity and visibility, original-row preservation.',
               '', 'See `map-comparison.md` for the per-database comparison.']
    (destination / 'README.md').write_text('\n'.join(summary) + '\n', encoding='utf-8')
    bridge_lines = ['# Added jump connections', '',
                    'Every row is a new reciprocal pair; original jump links are preserved.', '',
                    '| From system | To system | Jump point IDs | Purpose |', '|---|---|---|---|']
    for bridge in manifest['bridges']:
        endpoints = []
        for key in ('from_system', 'to_system'):
            name = db.execute('SELECT Name FROM FCT_RaceSysSurvey WHERE RaceID=? AND SystemID=?', (race_id, bridge[key])).fetchone()[0]
            endpoints.append(f'{name} ({bridge[key]})')
        bridge_lines.append(f'| {endpoints[0]} | {endpoints[1]} | {bridge["jump_ids"][0]} ↔ {bridge["jump_ids"][1]} | {bridge["kind"]} |')
    (destination / 'added-connections.md').write_text('\n'.join(bridge_lines) + '\n', encoding='utf-8')
    (destination / 'layout-report.json').write_text(json.dumps(manifest['layout'],indent=2),encoding='utf-8')
    write_reports(manifest,destination,db)
    db.close()
    base.close()
    print(json.dumps(dict(output=str(output.resolve()), systems=result['systems'], connections=result['connections'], bridges=len(manifest['bridges']))), flush=True)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', type=Path, required=True)
    parser.add_argument('--folder', type=Path, default=Path('.'))
    parser.add_argument('--destination', type=Path, default=Path('artifacts/combined-map'))
    parser.add_argument('--build', action='store_true')
    parser.add_argument('--game-id', type=int, default=138)
    parser.add_argument('--race-id', type=int, default=785)
    parser.add_argument('--seed', type=int)
    args = parser.parse_args()
    result = audit(args.base, args.folder, args.destination)
    if args.build:
        build(result, args.destination, args.game_id, args.race_id, args.seed)


if __name__ == '__main__':
    main()
