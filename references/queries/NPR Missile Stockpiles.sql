SELECT
	mt.Name
	--,dpi.Name
	,*
FROM
	FCT_PopulationWeapon as pw
inner JOIN
	FCT_Population as p on p.PopulationID = pw.PopulationID
inner JOIN
	FCT_SystemBody as sb on sb.SystemBodyID = p.SystemBodyID
inner JOIN
	FCT_MissileType as mt on mt.MissileID = pw.MissileID
--inner join FCT_PopulationInstallations as pi on pi.PopID = p.PopulationID
--inner join DIM_PlanetaryInstallation as dpi on dpi.PlanetaryInstallationID = pi.PlanetaryInstallationID
inner join FCT_Waypoint as wp on wp.OrbitBodyID = sb.SystemBodyID
WHERE
	p.RaceID = 619
--AND
--	sb.SystemID = 14024
AND
	mt.name = 'Scythe AMM'
order by
	p.PopName