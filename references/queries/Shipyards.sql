SELECT
	p.PopName
	,p.Population
	--,sy.*
	,s.ShipID
	,sy.ShipyardName
	,p.IsMoth
	,substr(sy.ShipyardName,0,instr(sy.ShipyardName, ' ')) as ClassBaseName
	,sy.Slipways
	,cast( substr( sy.ShipyardName ,instr(sy.ShipyardName, ' MOTH')+5,1 ) as int) as SlipwaysMothed
	,class.*
	--,*
FROM
	FCT_Shipyard as sy
left JOIN
(
	SELECT
		p.PopulationID
		,p.Population
		,p.PopName
		,CASE
			when p.PopName like '% MOTH%' then 1	-- colonies for mothballing yards have " MOTH" after the body name
			else 0
		end as IsMoth
		--,*
	from
		vw_pop as p
) as p
on
	sy.PopulationID = p.PopulationID
left join FCT_Ship as s on s.ShipID = sy.TractorParentShipID
left join FCT_Fleet as f on f.FleetID = s.FleetID
left join vw_const as c on c.RaceID = f.RaceID
left JOIN
	vw_shipClasses as class
on
	class.ShipClassID = sy.BuildClassID
WHERE
	(f.FleetID is not null and c.RaceID is not null)
OR
	(p.PopulationID is not null and sy.ShipyardName not like 'xxx%') --shipyards starting with xxx are either placeholders or fleetkeepers
order by p.PopName, sy.ShipyardName