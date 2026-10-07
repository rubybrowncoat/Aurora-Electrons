

/*
--select sb.SystemID, p.PopName, p.* from vw_pop as p inner join FCT_SystemBody as sb on sb.SystemBodyID = p.SystemBodyID where p.PopName like '%HUB%' order by p.PopName


select distinct sb.SystemID, p.MassDriverDest from vw_pop as p inner join FCT_SystemBody as sb on sb.SystemBodyID = p.SystemBodyID 
where p.MassDriverDest <> 0 
order by sb.SystemID
*/


select p.SystemID, * from vw_pop as p
where
(
	p.PopulationID in (select PopulationID from vw_orbitalMining)
or
	p.PopulationID in (select PopulationID from vw_mining_surface)
)
AND
--	p.MassDrivers = 0
	p.MassDriverDest = 0
order by p.SystemID, p.PopName

/*
insert into FCT_PopulationInstallations (GameID, PopID, PlanetaryInstallationID, Amount)
SELECT
	138
	,p.PopulationID
	,24
	,1.0
	from vw_pop as p
where
(
	p.PopulationID in (select PopulationID from vw_orbitalMining)
or
	p.PopulationID in (select PopulationID from vw_mining_surface)
)
AND
	p.MassDrivers = 0
*/

-- this will set hubs to themselves, so reset that after
update FCT_Population
set MassDriverDest = (select MassDriverDest from vw_pop as v where v.SystemID = FCT_Population.SystemID and MassDriverDest <> 0)
where
(
	FCT_Population.PopulationID in (select PopulationID from vw_orbitalMining)
or
	FCT_Population.PopulationID in (select PopulationID from vw_mining_surface)
)
AND
	FCT_Population.MassDriverDest = 0

--	update FCT_Population set MassDriverDest = 0 where MassDriverDest = PopulationID

select * from vw_pop as p
left join vw_pop as dest on dest.PopulationID = p.MassDriverDest and dest.SystemID = p.SystemID
where p.MassDriverDest > 0
and dest.SystemID is null


update FCT_Population set MassDriverDest = 0 where MassDriverDest is null
	
 