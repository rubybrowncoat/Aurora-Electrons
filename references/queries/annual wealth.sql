SELECT
	wu.Description
	,wu.Income
	,wu.DisplayOrder
	,sum(Amount)
FROM
	FCT_WealthData as wd
inner JOIN
	DIM_WealthUse as wu
on
	wu.WealthUseID = wd.UseID
inner JOIN
	FCT_Game as g
on
	g.GameID = wd.GameID
AND
	g.GameTime <= wd.TimeUsed + 31536000
WHERE
	wd.RaceID = (select max(RaceID) as RaceID from FCT_Race where NPR = 0)
group by wu.Description,wu.Income,wu.DisplayOrder
order by wu.Income desc,wu.DisplayOrder
	
	--order by
--	wd.TimeUsed desc