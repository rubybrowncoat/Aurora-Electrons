--TODO TODO TODO
--write query for colonies with terraforming amount defined but no gas selected


WITH CTE_IndustrialProjects as
(
	SELECT
		ip.PopulationID
		,case ip.ProductionType
			when 4 then 0 --space stations
			when 3 then 0 --ship components
			else ip.ProductionType
		end as ProductionTypeGroup
		,sum(ip.Percentage) as ProductionPercentageUsed
	from
		FCT_IndustrialProjects as ip
	inner JOIN
		vw_const as c on c.RaceID = ip.RaceID
	WHERE
		ip.Queue = 0
	group by
		ip.PopulationID
		,case ip.ProductionType
			when 4 then 0 --space stations
			when 3 then 0 --ship components
			else ip.ProductionType
		end
)

,CTE_GroundUnitTraining as 
(
	SELECT
		gut.PopulationID
		,sum(gut.TaskPercentage) as TaskPercentage
	FROM
		FCT_GroundUnitTraining as gut
	group by gut.PopulationID
)

SELECT
	*
FROM
(
	SELECT
		p.PopName
		,p.PopulationID
		,p.SurfacePopulation + p.OrbitalPopulation as Population
		,cast(p.Confacs + p.GU_ConfacsEquiv as int) as ConfacEquivs
		, cast(p.OrdFacs as int) as OrdFacs
		, cast(p.FtrFacs as int) as FtrFacs
		, p.GFCCs
		, case when p.Confacs + p.GU_ConfacsEquiv > 0 then ifnull(ip_confac.ProductionPercentageUsed,0) else 999.9 end as 	ConfacPercentageUsed
		, case when p.OrdFacs > 0 then ifnull(ip_ordfac.ProductionPercentageUsed,0) else 999.9 end as 						OrdfacPercentageUsed
		, case when p.FtrFacs > 0 then ifnull(ip_ftrfac.ProductionPercentageUsed,0) else 999.9 end as 						FtrfacPercentageUsed	
		, case when p.GFCCs > 0 then ifnull(gut.TaskPercentage,0) else 999.9 end as 						GroundUnitTrainingPercentageUsed	
	FROM
		vw_pop as p
	left JOIN CTE_IndustrialProjects as ip_confac
	on	ip_confac.PopulationID = p.PopulationID
	AND	ip_confac.ProductionTypeGroup = 0
	AND	p.Confacs + p.GU_ConfacsEquiv > 0
	left JOIN CTE_IndustrialProjects as ip_ordfac
	on	ip_ordfac.PopulationID = p.PopulationID
	AND	ip_ordfac.ProductionTypeGroup = 1
	AND	p.OrdFacs > 0
	left JOIN CTE_IndustrialProjects as ip_ftrfac
	on	ip_ftrfac.PopulationID = p.PopulationID
	AND	ip_ftrfac.ProductionTypeGroup = 2
	AND	p.FtrFacs > 0
	left JOIN CTE_GroundUnitTraining as gut on gut.PopulationID = p.PopulationID
	/*
	WHERE
		p.Confacs + p.GU_ConfacsEquiv + p.OrdFacs + p.FtrFacs  > 0	-- include any population that could have industrial production of any type 
	group by                              
		p.PopulationID, ip.ProductionTypeGroup
	order by ip.ProductionPercentageUsed
	*/
	--HAVING	sum(ip.Percentage) < 100
) as x
WHERE
(
	x.ConfacPercentageUsed < 99.9999999				-- using 100.0 will include colonies with calculated ship component percentages
or
	x.OrdfacPercentageUsed < 100.0
or
	x.FtrfacPercentageUsed < 100.0
or
	x.GroundUnitTrainingPercentageUsed < 100.0
)
AND
	x.PopName not like '%MOTH%'
