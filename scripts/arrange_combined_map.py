"""Preserve source map layouts, pack them closely, and link 2–3 leaf systems per map.

Only coordinates and previously generated inter-map jump points are changed.
Source saves are read-only. NumPy is used for systems without saved positions.
"""

import argparse
import collections
import json
import math
from pathlib import Path
import random
import shutil
import sqlite3


def bounds(positions):
    points = list(positions.values())
    return (min(p[0] for p in points), min(p[1] for p in points), max(p[0] for p in points), max(p[1] for p in points))


def center(positions):
    x0, y0, x1, y1 = bounds(positions)
    return ((x0+x1)/2, (y0+y1)/2)


def leaf_pairs(maps, positions):
    """One cycle keeps the maps connected; nearby disjoint chords give some a third link.

    Each map supplies leaves from its largest original component. Single-system
    maps reuse their only endpoint. Leaves are measured BEFORE any added links.
    """
    centers = [center({sid: positions[sid] for sid in item['systems']}) for item in maps]
    distance = lambda a, b: math.dist(centers[a], centers[b])
    order = [0]
    waiting = set(range(1, len(maps)))
    while waiting:
        next_map = min(waiting, key=lambda i: (distance(order[-1], i), i))
        order.append(next_map)
        waiting.remove(next_map)
    # Uncross the cycle without moving any systems.
    improved = True
    while improved:
        improved = False
        for i in range(len(order)-2):
            for j in range(i+2, len(order)):
                a, b = order[i], order[i+1]
                c, d = order[j], order[(j+1) % len(order)]
                if distance(a, c)+distance(b, d)+1e-6 < distance(a, b)+distance(c, d):
                    order[i+1:j+1] = reversed(order[i+1:j+1])
                    improved = True
    edges = [(order[i], order[(i+1) % len(order)]) for i in range(len(order))]
    linked = {tuple(sorted(edge)) for edge in edges}
    third = set()
    candidates = sorted((distance(a, b), a, b) for a in range(len(maps)) for b in range(a+1, len(maps)) if (a, b) not in linked)
    for _, a, b in candidates:
        if a not in third and b not in third:
            edges.append((a, b))
            third.update([a, b])
            if len(third) >= 2*(len(maps)//4):
                break
    used = collections.defaultdict(set)
    result = []
    for a, b in edges:
        left = [sid for sid in maps[a]['leaves'] if sid not in used[a]] or maps[a]['leaves']
        right = [sid for sid in maps[b]['leaves'] if sid not in used[b]] or maps[b]['leaves']
        x, y = min(((x, y) for x in left for y in right), key=lambda pair: (math.dist(positions[pair[0]], positions[pair[1]]), pair))
        used[a].add(x)
        used[b].add(y)
        result.append((x, y, 'leaf_cycle' if len(result) < len(maps) else 'leaf_extra'))
    return result


def source_layout(source, game_id, preferred_race, system_ids, edges, seed):
    races = source.execute('SELECT RaceID,RaceName,NPR FROM FCT_Race WHERE GameID=? ORDER BY NPR,RaceID', (game_id,)).fetchall()
    surveys = {}
    for rid, name, npr in races:
        surveys[rid] = {sid: (float(x), float(y)) for sid, x, y in source.execute('SELECT SystemID,Xcor,Ycor FROM FCT_RaceSysSurvey WHERE GameID=? AND RaceID=?', (game_id, rid)) if sid in system_ids and x is not None and y is not None and math.isfinite(x) and math.isfinite(y)}
    def score(race):
        return len(set(surveys[race[0]].values()) - {(0, 0)})
    humans = [race for race in races if not race[2]]
    if preferred_race is not None:
        reference = next(race for race in races if race[0] == preferred_race)
    else:
        reference = max(humans or races, key=lambda race: (score(race), -race[0]))
        if score(reference) == 0:
            reference = max(races, key=lambda race: (score(race), not race[2], -race[0]))
    coordinates = surveys[reference[0]]
    origins = sorted(sid for sid, point in coordinates.items() if point == (0, 0))
    capital = source.execute('SELECT SystemID FROM FCT_Population WHERE GameID=? AND RaceID=? ORDER BY Capital DESC,Population DESC,PopulationID LIMIT 1', (game_id, reference[0])).fetchone()
    kept_origin = capital[0] if capital and capital[0] in origins else origins[0] if origins else None
    fixed = {sid: point for sid, point in coordinates.items() if point != (0, 0) or sid == kept_origin}
    if not fixed:
        fixed[min(system_ids)] = (0.0, 0.0)
    generated = sorted(system_ids - fixed.keys())
    if not generated:
        return fixed, fixed.copy(), reference
    import numpy as np

    ids = sorted(system_ids)
    index = {sid: i for i, sid in enumerate(ids)}
    neighbors = collections.defaultdict(list)
    for a, b in edges:
        neighbors[a].append(b)
        neighbors[b].append(a)
    rng = random.Random(seed)
    placed = dict(fixed)
    remaining = set(generated)
    counts = collections.Counter()
    while remaining:
        progress = False
        for sid in sorted(remaining):
            anchors = [other for other in neighbors[sid] if other in placed]
            if not anchors:
                continue
            anchor = anchors[0]
            counts[anchor] += 1
            angle = counts[anchor]*math.pi*(3-math.sqrt(5)) + rng.random()*0.3
            radius = 180*math.sqrt(counts[anchor])
            x = sum(placed[other][0] for other in anchors)/len(anchors)
            y = sum(placed[other][1] for other in anchors)/len(anchors)
            placed[sid] = (x+radius*math.cos(angle), y+radius*math.sin(angle))
            remaining.remove(sid)
            progress = True
        if not progress:
            sid = min(remaining)
            x0, y0, x1, y1 = bounds(placed)
            angle = rng.random()*2*math.pi
            radius = max(x1-x0, y1-y0)/2+220
            placed[sid] = ((x0+x1)/2+radius*math.cos(angle), (y0+y1)/2+radius*math.sin(angle))
            remaining.remove(sid)
    points = np.array([placed[sid] for sid in ids], dtype=float)
    movable = np.array([sid not in fixed for sid in ids])
    edge_a = np.array([index[a] for a, b in edges], dtype=int)
    edge_b = np.array([index[b] for a, b in edges], dtype=int)
    # Local repulsion keeps new systems readable without spreading the whole map. Saved positions stay fixed through every iteration.
    for step in range(240):
        dx = points[:, None, 0]-points[None, :, 0]
        dy = points[:, None, 1]-points[None, :, 1]
        squared = np.maximum(dx*dx+dy*dy, 1.0)
        weight = np.maximum(8100/squared-8100/(560*560), 0)
        np.fill_diagonal(weight, 0)
        force = np.column_stack(((dx*weight).sum(axis=1), (dy*weight).sum(axis=1)))
        delta = points[edge_b]-points[edge_a]
        lengths = np.maximum(np.linalg.norm(delta, axis=1), 1)
        spring = delta * (0.8*(lengths-140)/lengths)[:, None]
        np.add.at(force, edge_a, spring)
        np.add.at(force, edge_b, -spring)
        force[~movable] = 0
        lengths = np.maximum(np.linalg.norm(force, axis=1), 1)
        temperature = 24*(1-step/240)+0.5
        points += force * (np.minimum(lengths, temperature)/lengths)[:, None]
    result = {sid: tuple(map(float, points[index[sid]])) for sid in ids}
    assert all(result[sid] == point for sid, point in fixed.items())
    return result, fixed, reference


def pack_maps(maps, gap=140):
    offsets = {0: (0.0, 0.0)}
    occupied = {0: bounds(maps[0]['positions'])}
    anchor = center(maps[0]['positions'])
    for index in sorted(range(1, len(maps)), key=lambda i: (-len(maps[i]['systems']), i)):
        x0, y0, x1, y1 = bounds(maps[index]['positions'])
        candidates = []
        for a0, b0, a1, b1 in occupied.values():
            for y in [b0-y0, b1-y1, (b0+b1-y0-y1)/2]:
                candidates.extend([(a0-gap-x1, y), (a1+gap-x0, y)])
            for x in [a0-x0, a1-x1, (a0+a1-x0-x1)/2]:
                candidates.extend([(x, b0-gap-y1), (x, b1+gap-y0)])
        feasible = []
        for dx, dy in candidates:
            rectangle = (x0+dx, y0+dy, x1+dx, y1+dy)
            if any(not (rectangle[2]+gap <= a0+1e-6 or a1+gap <= rectangle[0]+1e-6 or rectangle[3]+gap <= b0+1e-6 or b1+gap <= rectangle[1]+1e-6) for a0, b0, a1, b1 in occupied.values()):
                continue
            all_boxes = list(occupied.values())+[rectangle]
            width = max(r[2] for r in all_boxes)-min(r[0] for r in all_boxes)
            height = max(r[3] for r in all_boxes)-min(r[1] for r in all_boxes)
            midpoint = ((rectangle[0]+rectangle[2])/2, (rectangle[1]+rectangle[3])/2)
            score = math.sqrt(width*height)+0.08*math.dist(midpoint, anchor)+0.12*max(width, height)
            feasible.append((score, dx, dy, rectangle))
        _, dx, dy, rectangle = min(feasible)
        offsets[index] = (dx, dy)
        occupied[index] = rectangle
    return offsets


def write_reports(manifest, destination, database):
    result = manifest['validation']['target']
    layout = manifest['layout']
    preserved = sum(item['source_positions_preserved'] for item in layout['maps'])
    generated = sum(item['generated_positions'] for item in layout['maps'])
    before, after = layout['before_bounds'], layout['after_bounds']
    reduction = 1-((after[2]-after[0])*(after[3]-after[1]))/((before[2]-before[0])*(before[3]-before[1]))
    lines = ['# Combined Aurora Electrons map', '',
             'Open `AuroraDB_combined_maps.db`; select **EggSample**, race **EggSample Protectorate**.', '',
             f'- {len(layout["maps"])} maps; {result["systems"]:,} visible systems; {result["connections"]:,} paired jump connections.',
             f'- {len(manifest["bridges"])} new leaf-to-leaf connections. Each map receives two or three.',
             '- Leaves are selected from each map\'s largest original connected region. Tiny maps use isolated systems as endpoints.',
             '- The largest regions form one common network. Original secondary disconnected regions remain intact.',
             '- The previous percentage-based and component-bridging links have all been removed.',
             f'- {preserved:,} meaningful source positions preserved; {generated:,} previously unpositioned systems placed around their local jump connections.',
             '- Each source map retains its scale and orientation. Whole maps are translated into a compact arrangement with 140 units between their bounds.',
             '- The best-mapped human race supplies source coordinates; if no human has a laid-out map, the best-mapped available race is used. The base uses EggSample\'s coordinates.',
             f'- Bounding area is {reduction:.1%} smaller than the previous separated grids.',
             '- Duplicate maps match GameID and GameName; the copy with most systems is selected. Shared IDs alone imply no relationship.',
             '- Source databases, imported natural data, original jump links, empires and colonies are unchanged.',
             '- This database is for Aurora Electrons map visualization.', '',
             'See `layout-report.json` for reference races, translations and preserved coordinates; `merge-manifest.json` records ID translations and all generated connections.']
    (destination/'README.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
    lines = ['# Added leaf-to-leaf jump connections', '',
             'Source degree is measured before adding inter-map connections: one for a leaf, zero for an isolated system.', '',
             '| From system | To system | Source degrees | Jump point IDs | Purpose |', '|---|---|---|---|---|']
    for bridge in manifest['bridges']:
        endpoints = []
        for key in ['from_system','to_system']:
            sid = bridge[key]
            name = database.execute('SELECT Name FROM FCT_RaceSysSurvey WHERE GameID=? AND RaceID=? AND SystemID=?', (manifest['game_id'],manifest['race_id'],sid)).fetchone()[0]
            endpoints.append(f'{name} ({sid})')
        lines.append(f'| {endpoints[0]} | {endpoints[1]} | {bridge["source_leaf_degrees"]} | {bridge["jump_ids"][0]} ↔ {bridge["jump_ids"][1]} | {bridge["kind"]} |')
    (destination/'added-connections.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')


def arrange(database, manifest_path, destination):
    from combine_maps import audit_game, components

    destination.mkdir(parents=True, exist_ok=True)
    output = destination/'AuroraDB_combined_maps.db'
    if output.exists():
        raise FileExistsError(output)
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    original = sqlite3.connect(database.resolve().as_uri()+'?mode=ro', uri=True)
    original.row_factory = sqlite3.Row
    target = sqlite3.connect(output.resolve().as_uri(), uri=True)
    target.row_factory = sqlite3.Row
    original.backup(target)
    gid, rid = manifest['game_id'], manifest['race_id']
    seed = manifest['random_seed']
    records = [dict(file=manifest['base'], game_id=gid, game_name='EggSample')]+manifest['imports']
    maps = []
    source_stats = {}
    for i, record in enumerate(records):
        path = Path(record['file'])
        source_stats[str(path)] = (path.stat().st_size, path.stat().st_mtime_ns)
        source = sqlite3.connect(path.resolve().as_uri()+'?mode=ro', uri=True)
        source.row_factory = sqlite3.Row
        systems = [dict(r) for r in source.execute('SELECT * FROM FCT_System WHERE GameID=?', (record['game_id'],))]
        jumps = [dict(r) for r in source.execute('SELECT * FROM FCT_JumpPoint WHERE GameID=?', (record['game_id'],))]
        mapping = {s['SystemID']: s['SystemID'] for s in systems} if i == 0 else {int(k): v for k, v in record['id_maps']['SystemID'].items()}
        by_jump = {j['WarpPointID']: j for j in jumps}
        edges = sorted({tuple(sorted((j['SystemID'], by_jump[j['WPLink']]['SystemID']))) for j in jumps if j['WPLink'] in by_jump})
        local, fixed, reference = source_layout(source, record['game_id'], rid if i == 0 else None, set(mapping), edges, seed+i)
        groups = components(systems, jumps)
        degrees = collections.Counter(j['SystemID'] for j in jumps if j['WPLink'])
        leaves = [mapping[sid] for sid in groups[0] if degrees[sid] <= 1]
        if not leaves:
            raise ValueError(f'No leaf systems in {record["game_name"]}')
        maps.append(dict(file=record['file'], game_id=record['game_id'], game_name=record['game_name'], systems=list(mapping.values()), leaves=leaves, source_degrees={mapping[sid]: degrees[sid] for sid in mapping}, original_components=len(groups),main_component_systems=len(groups[0]), positions={mapping[sid]: point for sid, point in local.items()}, preserved={mapping[sid]: point for sid, point in fixed.items()}, reference_race=dict(race_id=reference[0], name=reference[1], npr=reference[2])))
        source.close()
        print(f'{record["game_name"]}: preserved {len(fixed)} positions; placed {len(mapping)-len(fixed)} unpositioned systems', flush=True)
    offsets = pack_maps(maps)
    positions = {sid: (x+offsets[i][0], y+offsets[i][1]) for i, item in enumerate(maps) for sid, (x, y) in item['positions'].items()}
    target.executemany('UPDATE FCT_RaceSysSurvey SET Xcor=?,Ycor=? WHERE GameID=? AND RaceID=? AND SystemID=?', [(x, y, gid, rid, sid) for sid, (x, y) in positions.items()])
    removed = [wid for bridge in manifest['bridges'] for wid in bridge['jump_ids']]
    target.executemany('DELETE FROM FCT_RaceJumpPointSurvey WHERE GameID=? AND WarpPointID=?', [(gid, wid) for wid in removed])
    target.executemany('DELETE FROM FCT_JumpPoint WHERE GameID=? AND WarpPointID=?', [(gid, wid) for wid in removed])
    next_id = target.execute('SELECT MAX(WarpPointID) FROM FCT_JumpPoint').fetchone()[0]+1
    origin_by_system = {sid: i for i, item in enumerate(maps) for sid in item['systems']}
    bridges = []
    for a, b, kind in leaf_pairs(maps, positions):
        ids = [next_id, next_id+1]
        next_id += 2
        for side, sid, peer in [(0, a, ids[1]), (1, b, ids[0])]:
            distance = 1496000000.0
            bearing = (len(bridges)*37+side*180) % 360
            radians = math.radians(bearing)
            target.execute('INSERT INTO FCT_JumpPoint (WarpPointID,GameID,SystemID,WPLink,Distance,Bearing,Xcor,Ycor,JumpGateStrength,JumpGateRaceID) VALUES (?,?,?,?,?,?,?,?,0,0)', (ids[side],gid,sid,peer,distance,bearing,distance*math.sin(radians),-distance*math.cos(radians)))
            target.execute('INSERT INTO FCT_RaceJumpPointSurvey (GameID,RaceID,WarpPointID,Charted,Explored,Hide) VALUES (?,?,?,1,1,0)', (gid,rid,ids[side]))
        provenance = lambda sid: {key: maps[origin_by_system[sid]][key] for key in ['file','game_id','game_name']}
        bridges.append(dict(from_system=a,to_system=b,from_region=provenance(a),to_region=provenance(b),jump_ids=ids,kind=kind, source_leaf_degrees=[maps[origin_by_system[sid]]['source_degrees'][sid] for sid in [a,b]]))
    target.commit()
    target.execute('ATTACH DATABASE ? AS previous', (database.resolve().as_uri()+'?mode=ro',))
    for row in target.execute("SELECT name FROM previous.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").fetchall():
        table = row[0]
        keys = [r['name'] for r in target.execute(f'PRAGMA table_info("{table}")')]
        if table == 'FCT_RaceSysSurvey':
            keys = [key for key in keys if key not in ['Xcor','Ycor']]
            where = ''
            params = ()
        elif table in ['FCT_JumpPoint','FCT_RaceJumpPointSurvey']:
            where = ' WHERE WarpPointID NOT IN ('+','.join('?' for _ in removed)+')'
            params = removed
        else:
            where = ''
            params = ()
        fields = ','.join('"'+key+'"' for key in keys)
        missing = target.execute(f'SELECT COUNT(*) FROM (SELECT {fields} FROM previous."{table}"{where} EXCEPT SELECT {fields} FROM main."{table}")',params).fetchone()[0]
        assert missing == 0, (table,missing)
    result = audit_game(target,dict(GameID=gid,GameName='EggSample'),str(output.resolve()))
    assert target.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
    assert not result['invalid_jump_ids']
    assert len(result['components']) == sum(item['original_components'] for item in maps)-len(maps)+1
    assert result['components'][0] == sum(item['main_component_systems'] for item in maps)
    map_degrees = collections.Counter(origin_by_system[sid] for b in bridges for sid in [b['from_system'],b['to_system']])
    assert all(2 <= map_degrees[i] <= 3 for i in range(len(maps)))
    assert all(degree <= 1 for b in bridges for degree in b['source_leaf_degrees'])
    report = dict(policy='Source coordinates preserved by translation only; unknown positions use anchored spring placement; map bounds separated by 140 units', seed=seed,before_bounds=bounds({r['SystemID']:(r['Xcor'],r['Ycor']) for r in original.execute('SELECT SystemID,Xcor,Ycor FROM FCT_RaceSysSurvey WHERE GameID=? AND RaceID=?',(gid,rid))}), after_bounds=bounds(positions),maps=[])
    for i,item in enumerate(maps):
        offset=offsets[i]
        for sid,point in item['preserved'].items():
            assert positions[sid] == (point[0]+offset[0],point[1]+offset[1])
        report['maps'].append(dict(file=item['file'],game_id=item['game_id'],game_name=item['game_name'],reference_race=item['reference_race'], translation=offset,source_positions_preserved=len(item['preserved']),generated_positions=len(item['systems'])-len(item['preserved']), connections=map_degrees[i],source_positions={sid:point for sid,point in item['preserved'].items()}))
    assert all((Path(p).stat().st_size,Path(p).stat().st_mtime_ns)==state for p,state in source_stats.items())
    manifest['output']=str(output.resolve())
    manifest['bridges']=bridges
    manifest['connection_policy']='2 or 3 inter-map connections per map; source leaves (degree 1), or isolated systems (degree 0), in each largest source component. Original secondary components are retained.'
    manifest.pop('extra_link_fraction',None)
    manifest.pop('random_link_samples',None)
    manifest['layout']=report
    manifest['validation'].pop('electron_smoke',None)
    manifest['validation'].update(target=result,visible_systems=len(positions),layout_source_positions_preserved=True,only_coordinates_and_generated_links_changed=True, inter_map_links_verified=dict(collections.Counter(b['kind'] for b in bridges)),all_maps_linked=len(maps),source_files_unchanged=True)
    (destination/'merge-manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
    (destination/'layout-report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    for name in ['map-audit.json','map-comparison.md']:
        if (manifest_path.parent/name).exists():
            shutil.copyfile(manifest_path.parent/name,destination/name)
    write_reports(manifest,destination,target)
    target.close()
    original.close()
    print(json.dumps(dict(output=str(output.resolve()),systems=result['systems'],connections=result['connections'],added_links=len(bridges),components=len(result['components']),before_bounds=report['before_bounds'],after_bounds=report['after_bounds'])),flush=True)


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--database',type=Path,default=Path('artifacts/combined-map/AuroraDB_combined_maps.db'))
    parser.add_argument('--manifest',type=Path,default=Path('artifacts/combined-map/merge-manifest.json'))
    parser.add_argument('--destination',type=Path,default=Path('artifacts/combined-map-natural-layout'))
    args=parser.parse_args()
    arrange(args.database,args.manifest,args.destination)
