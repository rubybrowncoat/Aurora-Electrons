with CTE_Commanders as
(
	SELECT
		cm.CommanderID
		,cm.ResSpecID
		,bnLabs.BonusValue as Labs
		,ifnull(bnBonus.BonusValue, 1.0) as BonusValue
		,round(21 + (c.GameTime - cm.CareerStart)/86400/365,1) as Age
		,*
	FROM
		vw_const as c
	inner join FCT_Commander as cm on cm.RaceID = c.RaceID and cm.CommanderType = 3
	inner join FCT_CommanderBonuses as bnLabs on bnLabs.CommanderID = cm.CommanderID and bnLabs.BonusID = 27	-- number of labs
	left join FCT_CommanderBonuses as bnBonus on bnBonus.CommanderID = cm.CommanderID and bnBonus.BonusID = 3	-- research bonus (raw multiplier)
)

--select * from CTE_Commanders

SELECT
	drf.FieldName
	,cm.Name, cm.HealthRisk, cm.CommandType, cm.Labs, cm.BonusValue, cm.Age
	,cmx.Name, cmx.HealthRisk, cmx.CommandType, cmx.Labs, cmx.BonusValue, cmx.Age
	,round((cmx.GameTimePromoted-cm.GameTimePromoted)/86400/365,1) as YearsYounger
	--,
	--*
-- select *
FROM
	FCT_ResearchProject as rp 
inner join vw_const as v on v.RaceID = rp.RaceID
inner join DIM_ResearchField as drf on drf.ResearchFieldID = rp.ResSpecID
inner join CTE_Commanders as cm on cm.CommandID = rp.ProjectID --and cm.RaceID = rp.RaceID
inner join CTE_Commanders as cmx on 
	--cmx.RaceID = rp.RaceID 	and 
	--cmx.CommanderType = 3 and 
	cmx.CommanderID <> cm.CommanderID 
	and cmx.ResSpecID = cm.ResSpecID
	and cmx.BonusValue >= cm.BonusValue
	and cmx.GameTimePromoted >= cm.GameTimePromoted
	and 
	(
		cmx.Labs >= cm.Labs		-- replacement has at least as high Labs
		or
		rp.Facilities = 1		-- project is only assigned one lab
	)
	and 
	(
		cmx.CommandID = 0		-- not assigned
		or 
		(cmx.CommandType = 17 and cm.Labs >= 5)  -- assigned as commandant and current researcher has enough maxlabs to be commandant
	)
	AND
	(
		cmx.HealthRisk <> 6		-- replacement is not in poor health, or
		or
		cm.HealthRisk = 6		--  current leader is in poor health
	)
--order by
	--drf.FieldName
	--,
	--cm.Name
	--,
	--cmx.GameTimePromoted desc