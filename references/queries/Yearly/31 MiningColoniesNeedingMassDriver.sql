SELECT
	p.PopName
	, sum(om.MiningRate) as MiningRate
	, phub.PopName as Hub
	, pdest.PopName as DestToUse
	, SystemColonies.SystemColonies
FROM
(
	select PopulationID, MiningRate from vw_orbitalMining
	union all
	select PopulationID, MiningRate from vw_mining_surface where IsOwned = 1
)	as om
inner join vw_pop as p on p.PopulationID = om.PopulationID
left join vw_pop as phub on phub.SystemID = p.SystemID and phub.PopName like '%HUB%'
left join
(
	select distinct p.SystemID, pdest.PopName
	from vw_pop as p 
	inner join vw_pop as pdest on pdest.PopulationID = p.MassDriverDest
	where p.MassDriverDest <> 0
) as pdest on pdest.SystemID = p.SystemID
left join 
(
	select 
		p.SystemID
		, count(*) as ColonyCount 
		,group_concat('' || p.PopName , ' ||| ') as SystemColonies	
	from (select SystemID, PopName from vw_pop order by PopName) as p 
	group by p.SystemID	
) as SystemColonies on SystemColonies.SystemID = p.SystemID
where 
	p.MassDriverDest = 0
AND
	p.PopName not like '%HUB%'
AND
	(pdest.PopName is null or p.PopName <> pdest.PopName)
AND
	SystemColonies.ColonyCount > 1
group by p.PopName
order by p.PopName