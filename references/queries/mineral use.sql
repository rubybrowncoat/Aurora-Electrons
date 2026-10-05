--query for current mineral consumption

WITH const AS 
	(select max(RaceID) as RaceID from FCT_Race where NPR = 0)

,CTE_IndustrialProjects as
(
	SELECT
		*
		,CASE
			WHEN ip.CompletionDays > 365 THEN 365 / ip.CompletionDays --only want one year's Cost
			ELSE 1
		END as OneYearCostFactor
		,CASE
			WHEN ip.CompletionDays > 365 THEN 1 --only want one year's percentage
			ELSE ip.CompletionDays / 365
		END as OneYearPercentageFactor
	from
		vw_industrialProjects as ip
)

,CTE_OneYearProduction as
(
	SELECT
		ip.PopulationID
		,ip.ProductionFacility
		,ip.Queue
		,sum(ip.OneYearCostFactor * ip.BP) 				as BP
		,sum(ip.OneYearCostFactor * ip.Duranium		)	as Duranium	
		,sum(ip.OneYearCostFactor * ip.Neutronium	)	as Neutronium	
		,sum(ip.OneYearCostFactor * ip.Corbomite	)	as Corbomite	
		,sum(ip.OneYearCostFactor * ip.Tritanium	)	as Tritanium	
		,sum(ip.OneYearCostFactor * ip.Boronide		)	as Boronide	
		,sum(ip.OneYearCostFactor * ip.Mercassium	)	as Mercassium	
		,sum(ip.OneYearCostFactor * ip.Vendarite	)	as Vendarite	
		,sum(ip.OneYearCostFactor * ip.Sorium		)	as Sorium		
		,sum(ip.OneYearCostFactor * ip.Uridium		)	as Uridium		
		,sum(ip.OneYearCostFactor * ip.Corundium	)	as Corundium	
		,sum(ip.OneYearCostFactor * ip.Gallicite	)	as Gallicite
		,sum(ip.OneYearPercentageFactor * ip.Percentage) as YearPercentage
		,0 as LastItemBP
		,0 as LastItemPercentage
		,0 as LastItemCompletionDays
	FROM
		CTE_IndustrialProjects as ip
	WHERE
		ip.Queue = 0
	group by
		ip.PopulationID
		,ip.ProductionFacility
		
	union ALL
	
	SELECT
		ip.PopulationID
		,ip.ProductionFacility
		,ip.Queue
		,cte.BP + (ip.OneYearCostFactor * ip.BP) 					as BP
		,cte.Duranium + (ip.OneYearCostFactor * ip.Duranium	)		as Duranium	
		,cte.Neutronium + (ip.OneYearCostFactor * ip.Neutronium	)	as Neutronium	
		,cte.Corbomite + (ip.OneYearCostFactor * ip.Corbomite	)	as Corbomite	
		,cte.Tritanium + (ip.OneYearCostFactor * ip.Tritanium	)	as Tritanium	
		,cte.Boronide + (ip.OneYearCostFactor * ip.Boronide	)		as Boronide	
		,cte.Mercassium + (ip.OneYearCostFactor * ip.Mercassium	)	as Mercassium	
		,cte.Vendarite + (ip.OneYearCostFactor * ip.Vendarite	)	as Vendarite	
		,cte.Sorium + (ip.OneYearCostFactor * ip.Sorium		)		as Sorium		
		,cte.Uridium + (ip.OneYearCostFactor * ip.Uridium	)		as Uridium		
		,cte.Corundium + (ip.OneYearCostFactor * ip.Corundium	)	as Corundium	
		,cte.Gallicite + (ip.OneYearCostFactor * ip.Gallicite	)	as Gallicite
		,cte.YearPercentage + (ip.OneYearPercentageFactor * ip.Percentage) as YearPercentage
		,ip.BP as LastItemBP
		,ip.Percentage as LastItemPercentage
		,ip.CompletionDays as LastItemCompletionDays
	FROM
		CTE_OneYearProduction as cte
	inner join
		CTE_IndustrialProjects as ip
	on
		ip.PopulationID = cte.PopulationID
	AND
		ip.ProductionFacility = cte.ProductionFacility
	AND
		ip.Queue = cte.Queue + 1	
	WHERE
		cte.YearPercentage < 100
)

select * from CTE_OneYearProduction
order by PopulationID, ProductionFacility, Queue

--ShipBuilding

--shiprepair

--shiprefit

--shipyard mods

--ground units