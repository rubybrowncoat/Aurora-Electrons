select bn.BodyName , sb.PlanetNumber, sb.OrbitNumber, * from FCT_AtmosphericGas as ag
inner join FCT_SystemBody as sb on sb.SystemBodyID = ag.SystemBodyID
inner join FCT_RaceSysSurvey as rss on rss.SystemID = sb.SystemID
inner join vw_const as c on c.RaceID = rss.RaceID
inner join vw_BodyName as bn on bn.SystemBodyID = sb.SystemBodyID
left join FCT_Population as p on p.RaceID = rss.RaceID and p.SystemBodyID = sb.SystemBodyID
where 
	(p.PopulationID is null or p.Population = 0)
AND
	ag.AtmosGasID = 10	-- oxygen
AND
	ag.GasAtm BETWEEN 0.07 AND 0.4
AND
	ag.AtmosGasAmount <= 30.0
order by rss.name, sb.PlanetNumber, sb.OrbitNumber